# 第 03 章：授權與權限模型

> 00 章 0.3.1 那個事故，到現在**一行都沒有修**：
>
> ```
> alice 登入了（02 章做完了）
> alice 打 GET /api/orders/1002（bob 的訂單）
> → 200，完整的訂單內容
> ```
>
> 前兩章回答的是「**你是誰**」。這一章要回答另外兩個問題：
>
> ```
> 你可以做什麼？     → 角色、權限、規則        → 3.3～3.7
> 這筆資料是不是你的？ → 必須把資料撈出來才知道   → 3.8   ★ 最難的一層
> ```
>
> 📌 **這一章有四十六個實測。** 其中六個值得先劇透，因為它們會改變你寫程式碼的方式：
>
> ```
> 3.3.4  規則只寫了 GET，匿名的 POST /api/admin/users 拿到【200】
> 3.4.3  hasRole("ROLE_ADMIN")：URL 層【啟動就失敗】、方法層【完全正常】—— 同一句話，兩種待遇
> 3.5.5  @PreAuthorize 標在被同類別直接呼叫的方法上，形同不存在，而且沒有任何警告
> 3.5.6  @PostAuthorize 回了 403，但那筆 UPDATE 【已經 commit 了】
> 3.5.8  一個 @ExceptionHandler(Exception.class)，把方法層的 403 變成 500
> 3.8.5  @PostFilter 遇上 Spring Data 的 Page，回應是【500】
> ```
>
> ⚠️ **這一章有一個貫穿全章的判準**：
>
> > **授權規則寫得對不對，不能用「試一次能不能進去」來驗證。**
> > 要用**矩陣**——同一批端點 × 同一批帳號，一次全部打過。
> > 3.1.2 會先把這個工具建起來，後面每一節都會用到它。

---

## 3.1 學習目標與實驗環境

完成本章後，你應該可以：

- 說出授權的三層各自在什麼時候發生、各自看得到什麼資訊（3.2.1）。
- 讀懂 `AuthorizationManager` 的介面，並說出 `AuthorizationDecision` 的三種可能（3.2.3）。
- 把一個專案的**授權規則表**印出來，並看懂每一條規則背後是哪一個 `AuthorizationManager`（3.2.4）。
- 說出 `authorizeHttpRequests` 的規則是怎麼被評估的，以及**順序寫反的兩種結局**（3.3.2）。
- 指出「規則只寫了 GET」造成的洞，並說出為什麼它不會被一般測試抓到（3.3.4）。
- 說明 `StrictHttpFirewall` 擋掉的四種路徑，以及**為什麼你看到的是 401 而不是 400**（3.3.5）。
- 分清楚 `permitAll` / `denyAll` / `anonymous` / `authenticated` / `fullyAuthenticated` 的差別，
  特別是 remember-me 身分在後兩者的行為（3.3.6）。
- 解釋 `ROLE_` 前綴是誰加的、加在哪一行，
  以及 `hasRole("ROLE_ADMIN")` 在 URL 層與方法層**為什麼待遇不同**（3.4）。
- 用 `@EnableMethodSecurity` 打開方法層授權，並說出四種註解各自的行為（3.5.2）。
- 診斷「`@PreAuthorize` 沒生效」的三個原因（3.5.2、3.5.5）。
- 說出 `@PostAuthorize` 的三個代價，並用攔截器順序解釋**為什麼交易不會回滾**（3.5.6）。
- 說明 `@PreFilter` / `@PostFilter` 的行為與它們的效能上限（3.5.7）。
- 追蹤 `AccessDeniedException` 在 Filter 層與方法層的**兩條不同出口**（3.5.8）。
- 設計一套 RBAC 的資料表，並把權限展開成 `GrantedAuthority`（3.7.3、3.7.4）。
- 說出 `RoleHierarchy` 在 URL 層與方法層的**不同待遇**，並把它接對（3.7.5）。
- 在四種資源層做法中選對一種，並說出各自的 SQL 句數與資料外洩面（3.8.3）。
- 決定一個端點該回 403 還是 404（3.8.4）。
- 說明為什麼「列表端點」不能用 `@PostFilter` 解決（3.8.5）。
- 寫出一張**端點 × 角色**的授權矩陣測試，並用**同角色的兩個帳號**驗證資源層（3.9）。
- 掃描出「只靠 `anyRequest()` 兜底、又沒有方法層註解」的端點（3.9.4）。

### 3.1.1 本章的實驗環境

**這一章的每一個數字都在同一個環境上跑出來的**：

| 項目 | 版本 |
|---|---|
| Spring Boot | 3.2.5 |
| Spring Security | 6.2.4 |
| JDK | Temurin 21.0.5 |
| MySQL | 8.0.46（02 章 2.1.1 那個容器，繼續用） |
| 機器 | Apple M2 / macOS 14.2.1（8 顆邏輯核心） |

**① 資料庫沿用 02 章那一個容器**：

```
docker run -d --name sec-mysql -p 33307:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=lab09 \
  mysql:8.0 --max_connections=600
```

**② 這一章多五張表**（3.7.3 會逐張解釋這些設計決定；`app_user` / `authority` 是 02 章 2.1.1 建的）：

```sql
USE lab09;

-- 角色（不含 ROLE_ 前綴 —— 前綴是【載入時】才加的，3.4.1 會解釋為什麼）
CREATE TABLE app_role (
  id   BIGINT      NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL COMMENT '例如 ADMIN、CS_AGENT、MEMBER',
  name VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_role_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 權限（動詞式命名，3.7.6）
CREATE TABLE permission (
  id   BIGINT      NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL COMMENT '例如 order:refund',
  name VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_perm_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE role_permission (
  role_id       BIGINT NOT NULL,
  permission_id BIGINT NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id)       REFERENCES app_role(id),
  CONSTRAINT fk_rp_perm FOREIGN KEY (permission_id) REFERENCES permission(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_role (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES app_user(id),
  CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES app_role(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 這一章的訂單改成真的一張表（00 章那個是記憶體 Map，量不出 SQL）
CREATE TABLE ord3 (
  id             BIGINT        NOT NULL AUTO_INCREMENT,
  owner_username VARCHAR(64)   NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  status         VARCHAR(16)   NOT NULL,
  PRIMARY KEY (id),
  KEY idx_ord3_owner (owner_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**③ 五個帳號、三個角色**：

```
帳號     密碼   authority 表（02 章）        app_role（3.7 起）    這一章為什麼需要他
────────────────────────────────────────────────────────────────────────────────────
alice   pw    ROLE_USER                   MEMBER              一般會員
bob     pw    ROLE_USER                   MEMBER              ★ 跟 alice【同角色】—— 資源層唯一測得出來的方式
cs      pw    ROLE_CS_AGENT               CS_AGENT            客服：看得到所有訂單，但不能刪
admin   pw    ROLE_USER, ROLE_ADMIN,      ADMIN               管理員
              order:refund
（另外還有 carol / dave / erin / frank —— 02 章 2.7.6 那四個壞掉的帳號狀態，這一章用不到）
```

⚠️ **`bob` 是這一章最重要的帳號。**
授權矩陣是「端點 × **角色**」，而資源層授權的錯誤是「同一個角色的**不同人**」。
**只有 alice 與 bob 兩個 `ROLE_USER` 擺在一起，3.8 那些洞才會現形。**

**④ 三張訂單**：

```sql
INSERT INTO ord3 (id, owner_username, amount, status) VALUES
  (1001, 'alice',  1280.00, 'PAID'),
  (1002, 'bob',   99000.00, 'PAID'),
  (1003, 'bob',     350.00, 'SHIPPED');
```

**⑤ 固定裝置**（每個測試的 `@BeforeEach` 都會重跑一次）：

```java
package com.example.lab09.ch03;

import com.example.lab09.ch02.Seed;                 // 02 章 2.1.1 的七個帳號
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

/** 03 章的固定裝置：RBAC 三張表 + 一張真的訂單表。 */
public class Seed3 {

    /** 角色 → 權限。這張圖就是 3.7 要放進資料庫的東西。 */
    public static final List<String[]> ROLE_PERMS = List.of(
            new String[]{"ADMIN",    "order:read", "order:read:all", "order:refund", "order:delete", "report:read", "user:manage"},
            new String[]{"CS_AGENT", "order:read", "order:read:all", "order:refund"},
            new String[]{"MEMBER",   "order:read"});

    /** 使用者 → 角色 */
    public static final List<String[]> USER_ROLES = List.of(
            new String[]{"alice", "MEMBER"},
            new String[]{"bob",   "MEMBER"},
            new String[]{"cs",    "CS_AGENT"},
            new String[]{"admin", "ADMIN"});

    public static void reset(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM user_role");
        jdbc.update("DELETE FROM role_permission");
        jdbc.update("DELETE FROM permission");
        jdbc.update("DELETE FROM app_role");
        Seed.reset(jdbc);                                     // 02 章 2.1.1 的七個帳號
        Seed.add(jdbc, "cs", "pw", "客服小美", true, true, true, null, "ROLE_CS_AGENT");

        for (String[] r : ROLE_PERMS) {
            jdbc.update("INSERT INTO app_role (code, name) VALUES (?,?)", r[0], r[0]);
            for (int i = 1; i < r.length; i++) {
                jdbc.update("INSERT IGNORE INTO permission (code, name) VALUES (?,?)", r[i], r[i]);
                jdbc.update("""
                        INSERT INTO role_permission (role_id, permission_id)
                        SELECT r.id, p.id FROM app_role r, permission p WHERE r.code=? AND p.code=?""",
                        r[0], r[i]);
            }
        }
        for (String[] ur : USER_ROLES)
            jdbc.update("""
                    INSERT INTO user_role (user_id, role_id)
                    SELECT u.id, r.id FROM app_user u, app_role r WHERE u.username=? AND r.code=?""",
                    ur[0], ur[1]);
    }

    /** 三張訂單，跟 00 章 0.8.2 的固定裝置一樣：alice 一張、bob 兩張。 */
    public static void orders(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM ord3");
        jdbc.update("INSERT INTO ord3 (id, owner_username, amount, status) VALUES (1001,'alice',1280.00,'PAID')");
        jdbc.update("INSERT INTO ord3 (id, owner_username, amount, status) VALUES (1002,'bob',99000.00,'PAID')");
        jdbc.update("INSERT INTO ord3 (id, owner_username, amount, status) VALUES (1003,'bob',350.00,'SHIPPED')");
    }

    /** 3.8.5 分頁實驗用：alice 只有 3 張，其他 n-3 張都是別人的。 */
    public static void bulkOrders(JdbcTemplate jdbc, int n) {
        jdbc.update("DELETE FROM ord3");
        jdbc.update("INSERT INTO ord3 (id, owner_username, amount, status) VALUES (1,'alice',100.00,'PAID')");
        jdbc.update("INSERT INTO ord3 (id, owner_username, amount, status) VALUES (2,'alice',200.00,'PAID')");
        jdbc.update("INSERT INTO ord3 (id, owner_username, amount, status) VALUES (3,'alice',300.00,'PAID')");
        StringBuilder sb = new StringBuilder();
        for (int i = 4; i <= n; i++) {
            if (!sb.isEmpty()) sb.append(',');
            sb.append("(").append(i).append(",'bob',").append(i).append(".00,'PAID')");
            if (i % 1000 == 0 || i == n) {
                jdbc.update("INSERT INTO ord3 (id, owner_username, amount, status) VALUES " + sb);
                sb.setLength(0);
            }
        }
    }
}
```

**⑥ 訂單的 Entity 與 Repository**（3.8 會一直用到）：

```java
package com.example.lab09.ch03;

import jakarta.persistence.*;
import org.hibernate.annotations.Filter;
import org.hibernate.annotations.FilterDef;
import org.hibernate.annotations.ParamDef;

import java.math.BigDecimal;

@Entity
@Table(name = "ord3")
// 3.8.7：定義一個「資料範圍」過濾器。定義了不等於啟用 —— 要在 Session 上明確 enableFilter 才生效。
@FilterDef(name = "ownerScope", parameters = @ParamDef(name = "owner", type = String.class))
@Filter(name = "ownerScope", condition = "owner_username = :owner")
public class Ord3 {

    @Id
    private Long id;

    @Column(name = "owner_username", nullable = false, length = 64)
    private String ownerUsername;

    @Column(nullable = false)
    private BigDecimal amount;

    @Column(nullable = false, length = 16)
    private String status;

    protected Ord3() {}

    public Long getId() { return id; }
    public String getOwnerUsername() { return ownerUsername; }
    public BigDecimal getAmount() { return amount; }
    public String getStatus() { return status; }
    public void setStatus(String s) { this.status = s; }

    @Override public String toString() {
        return "Ord3(" + id + ", " + ownerUsername + ", " + amount + ", " + status + ")";
    }
}
```

```java
package com.example.lab09.ch03;

import org.springframework.data.domain.*;
import org.springframework.data.jpa.repository.*;
import org.springframework.data.repository.query.Param;

import java.util.*;

public interface Ord3Repo extends JpaRepository<Ord3, Long> {

    List<Ord3> findByOwnerUsername(String owner);

    Page<Ord3> findByOwnerUsername(String owner, Pageable pageable);

    /** 3.8.2 做法 D：把「是誰的」寫進查詢條件 */
    Optional<Ord3> findByIdAndOwnerUsername(Long id, String owner);

    /** 3.8.6：一句 UPDATE 就把授權條件帶進去 */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update Ord3 o set o.status = 'CANCELLED' where o.id = :id and o.ownerUsername = :owner")
    int cancelOwned(@Param("id") Long id, @Param("owner") String owner);
}
```

**⑦ 幾支只回一行字的端點**，用來看狀態碼：

```java
package com.example.lab09.ch03;

import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/** 03 章 URL 層實驗用的端點。每一支都只回一行字，方便看狀態碼。 */
@RestController
@RequestMapping("/api")
public class Ch03Endpoints {

    @GetMapping("/reports/daily")
    public Map<String, Object> report() { return Map.of("endpoint", "GET /api/reports/daily"); }

    @PostMapping("/orders")
    public Map<String, Object> create() { return Map.of("endpoint", "POST /api/orders"); }

    @PostMapping("/orders/{id}/refund")
    public Map<String, Object> refund(@PathVariable String id) {
        return Map.of("endpoint", "POST /api/orders/" + id + "/refund");
    }

    @GetMapping("/admin/users")
    public Map<String, Object> users() { return Map.of("endpoint", "GET /api/admin/users"); }

    @PostMapping("/admin/users")
    public Map<String, Object> createUser() { return Map.of("endpoint", "POST /api/admin/users"); }

    /** 3.4 的八支端點都走這一支 —— 差別完全在安全設定，不在程式碼 */
    @GetMapping("/r/{rule}")
    public Map<String, Object> rule(@PathVariable String rule) { return Map.of("rule", rule); }

    /** 回傳目前身分帶了哪些 authority —— 3.4 / 3.7 的觀察窗 */
    @GetMapping("/me/authorities")
    public Map<String, Object> authorities(Authentication auth) {
        // ⚠️ 不要寫成 new LinkedHashMap<>(Map.of(...)) —— Map.of() 不保證順序，
        //    JSON 的欄位順序會每次執行都不一樣，課本上的輸出就對不起來了
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", auth == null ? "(匿名)" : auth.getName());
        out.put("authorities", auth == null ? List.of()
                : auth.getAuthorities().stream().map(Object::toString).sorted().toList());
        return out;
    }
}
```

> 🔴 **`user_role` 那條外鍵會弄壞 02 章的固定裝置。**
>
> 02 章 2.1.1 的 `Seed.reset()` 是這樣清資料的：
>
> ```java
> jdbc.update("DELETE FROM authority");
> jdbc.update("DELETE FROM app_user");      // ← 這一句現在會失敗
> ```
>
> ```
> java.sql.SQLIntegrityConstraintViolationException:
>   Cannot delete or update a parent row: a foreign key constraint fails
>   (`lab09`.`user_role`, CONSTRAINT `fk_ur_user` FOREIGN KEY (`user_id`) REFERENCES `app_user` (`id`))
> ```
>
> **建完 03 章這五張表之後，`Seed.reset()` 要多一句**：
>
> ```java
> public static void reset(JdbcTemplate jdbc) {
>     // ⚠️ 03 章 3.1.1 加了 user_role，它有一條指向 app_user 的外鍵 ——
>     //    不先清掉，下面那句 DELETE FROM app_user 會被外鍵擋住
>     jdbc.update("DELETE FROM user_role");
>     jdbc.update("DELETE FROM authority");
>     jdbc.update("DELETE FROM app_user");
>     ...
> }
> ```
>
> 📌 **這是外鍵的一般性教訓，不是這一章特有的**：
> 加一張參照既有表的表，就等於改動了**所有清空那張表的程式碼**——
> 包含測試的固定裝置、資料匯入腳本、以及「刪除帳號」那支 API。
> **加外鍵時順手 `grep` 一次 `DELETE FROM <被參照的表>`。**

**⑧ 共用的 `PasswordEncoder`**（02 章 2.1.1 起帳號在 MySQL，所以每條 chain 都要有一個）：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;

/** 03 章所有情境共用的東西。 */
@Configuration
@Profile("ch3")
public class Ch3Common {
    @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }
}
```

**⑨ 三支「只是把 Service 方法接出來」的 Controller。**
它們本身沒有任何授權邏輯——**這一章所有的差別都在設定與註解上**，
把它們集中放在這裡，後面的小節就不用再貼一次：

```java
package com.example.lab09.ch03;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/** 3.5 用：把 OrderService3 的每一個方法各開一支端點。 */
@RestController
@RequestMapping("/api/m")
@Profile("m1 | m2")
public class MethodSecurityController {

    private final OrderService3 svc;
    private final JdbcTemplate jdbc;
    @Autowired @Lazy OrderService3 self;      // 3.5.5 修法 A：注入自己（走代理）

    public MethodSecurityController(OrderService3 svc, JdbcTemplate jdbc) {
        this.svc = svc; this.jdbc = jdbc;
    }

    @GetMapping("/all")                   public Object all()          { return svc.allOrders(); }
    @GetMapping("/double-prefix")         public Object doublePrefix() { return svc.doublePrefix(); }
    @GetMapping("/authority-no-prefix")   public Object anp()          { return svc.authorityNoPrefix(); }
    @GetMapping("/authority-with-prefix") public Object awp()          { return svc.authorityWithPrefix(); }
    @PostMapping("/refund/{id}")          public Object refund(@PathVariable Long id) { return svc.refund(id); }
    @GetMapping("/by-owner")              public Object byOwner(@RequestParam String owner) { return svc.byOwner(owner); }
    @GetMapping("/one/{id}")              public Object one(@PathVariable Long id) { return svc.findOne(id); }
    @GetMapping("/filtered")              public Object filtered()     { return svc.allThenFilter(); }
    @GetMapping("/outer")                 public Object outer()        { return svc.outerCallsInner(); }
    @GetMapping("/outer-private")         public Object outerPrivate() { return svc.outerCallsPrivate(); }
    @GetMapping("/outer-self")            public Object outerSelf()    { return svc.outerViaSelf(self); }

    @PostMapping("/ship/{id}")
    public Object ship(@PathVariable Long id) { return svc.markShipped(id); }

    /** 交易到底有沒有 rollback：直接問資料庫（3.5.6） */
    @GetMapping("/status/{id}")
    public Map<String, Object> status(@PathVariable Long id) {
        Map<String, Object> out = new LinkedHashMap<>();       // ⚠️ 理由同 Ch03Endpoints.authorities
        out.put("id", id);
        out.put("statusInDb", jdbc.queryForObject("SELECT status FROM ord3 WHERE id=?", String.class, id));
        return out;
    }

    @PostMapping("/bulk-cancel")
    public Object bulkCancel(@RequestBody List<Long> ids) {
        return svc.bulkCancel(new ArrayList<>(ids.stream().map(svc::findOneRaw).toList()));
    }
}
```

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.*;

/** 3.5.2 / 3.5.9 / 3.6 用。 */
@RestController
@RequestMapping("/api/l")
@Profile("m3 | m4 | m5 | m6")
public class LegacyController {

    private final LegacyService3 svc;
    private final Ord3Repo repo;
    public LegacyController(LegacyService3 svc, Ord3Repo repo) { this.svc = svc; this.repo = repo; }

    @GetMapping("/secured-prefix")   public Object a() { return svc.securedWithPrefix(); }
    @GetMapping("/secured-noprefix") public Object b() { return svc.securedNoPrefix(); }
    @GetMapping("/roles-allowed")    public Object c() { return svc.rolesAllowed(); }
    @GetMapping("/permit-all")       public Object d() { return svc.permitAll(); }
    @GetMapping("/deny-all")         public Object e() { return svc.denyAll(); }
    @GetMapping("/iface-daily")      public Object f() { return svc.daily(); }
    @GetMapping("/iface-monthly")    public Object g() { return svc.monthly(); }
    @GetMapping("/meta/{id}")        public Object h(@PathVariable Long id) { return svc.byMetaAnnotation(id, repo); }
    @GetMapping("/bean/{id}")        public Object i(@PathVariable Long id) { return svc.byBeanExpression(id, repo); }
}
```

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.Profile;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/** 3.8 用：四種資源層做法各一支端點，外加兩支量 SQL 的。 */
@RestController
@RequestMapping("/api/res")
@Profile("res")
public class OwnershipController {

    private final OwnershipService svc;
    private final Sql3 sql;
    public OwnershipController(OwnershipService svc, Sql3 sql) { this.svc = svc; this.sql = sql; }

    // ── 量測用的兩支端點（實驗專案專用）──
    @PostMapping("/sql-reset") public Map<String, Object> reset() { sql.reset(); return Map.of("ok", true); }
    @GetMapping("/sql-count")  public Map<String, Object> count() {
        return Map.of("statements", sql.statements(), "entitiesLoaded", sql.entitiesLoaded());
    }

    /** A：檢查寫在 Controller */
    @GetMapping("/a/{id}")
    public Ord3 a(@PathVariable Long id, Authentication me) {
        Ord3 o = svc.loadRaw(id);
        if (!OwnershipService.isStaff(me) && !o.getOwnerUsername().equals(me.getName()))
            throw new org.springframework.security.access.AccessDeniedException("不是你的訂單");
        return o;
    }

    @GetMapping("/b/{id}") public Ord3 b(@PathVariable Long id, Authentication me) { return svc.loadChecked(id, me); }
    @GetMapping("/c/{id}") public Ord3 c(@PathVariable Long id) { return svc.loadPostAuthorize(id); }
    @GetMapping("/d/{id}") public Ord3 d(@PathVariable Long id, Authentication me) { return svc.loadScoped(id, me); }

    /** 3.8.4：把 403 換成 404 */
    @GetMapping("/b404/{id}")
    public Ord3 b404(@PathVariable Long id, Authentication me) {
        try { return svc.loadChecked(id, me); }
        catch (org.springframework.security.access.AccessDeniedException e) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.NOT_FOUND);
        }
    }

    // ── 列表（3.8.5）──
    @GetMapping("/list/postfilter")
    public Map<String, Object> listPostFilter(@RequestParam(defaultValue = "0") int page,
                                              @RequestParam(defaultValue = "20") int size) {
        List<Ord3> rows = svc.pageThenFilter(page, size);
        return listBody(page, size, rows.size(), rows.stream().map(Ord3::getId).toList());
    }

    @GetMapping("/list/postfilter-mutable")
    public Map<String, Object> listPostFilterMutable(@RequestParam(defaultValue = "0") int page,
                                                     @RequestParam(defaultValue = "20") int size) {
        List<Ord3> rows = svc.pageThenFilterMutable(page, size);
        return listBody(page, size, rows.size(), rows.stream().map(Ord3::getId).toList());
    }

    @GetMapping("/list/scoped")
    public Map<String, Object> listScoped(Authentication me,
                                          @RequestParam(defaultValue = "0") int page,
                                          @RequestParam(defaultValue = "20") int size) {
        var p = svc.pageScoped(me.getName(), page, size);
        Map<String, Object> out = listBody(page, size, p.getNumberOfElements(),
                p.getContent().stream().map(Ord3::getId).toList());
        out.put("totalElements", p.getTotalElements());       // ★ 只有查詢條件版算得出正確的總數
        out.put("totalPages", p.getTotalPages());
        return out;
    }

    /** 固定欄位順序的回應本體（Map.of 不保證順序，輸出會每次都不一樣） */
    private static Map<String, Object> listBody(int page, int size, int returned, List<Long> ids) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("page", page);
        out.put("size", size);
        out.put("回給前端的筆數", returned);
        out.put("ids", ids);
        return out;
    }

    // ── 寫入（3.8.6）──
    @PostMapping("/cancel-rw/{id}")
    public Object cancelRw(@PathVariable Long id, Authentication me) { return svc.cancelReadThenWrite(id, me); }

    @PostMapping("/cancel-scoped/{id}")
    public Object cancelScoped(@PathVariable Long id, Authentication me) { return svc.cancelScoped(id, me); }
}
```

**⑩ 應用程式進入點。** 3.3.2 與 3.4.3 那兩個「啟動就失敗」的實測會直接 `run()` 它，
所以這裡把它補齊（00 章 0.8.1 建的專案就是這一個）：

```java
package com.example.lab09;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class LabApp {
    public static void main(String[] args) { SpringApplication.run(LabApp.class, args); }
}
```

> ⚠️ **實驗專案的 profile 慣例**（跟 02 章 2.1.1 一樣）：
> 每一種設定各一個 profile，測試用 `@ActiveProfiles` 切換。
> 本章的 profile 有 `u1`～`u7`（URL 層）、`r1`～`r3`（角色前綴）、
> `p1` `p2`（探針）、`m1`～`m4`（方法層）、`rbac` `rh` `rh2` `sess3`（RBAC）、`res`（資源層），
> 全部再加一個共用的 `ch3` 與 02 章的 `db`。
> **你自己的專案只會有一種設定，不需要這些。**

### 3.1.2 兩個新工具：授權矩陣與規則表

**第一個工具：授權矩陣。**

這一章從頭到尾在回答「誰可以做什麼」，而那是一張**二維表**。
一次只打一個請求，看到 200 就以為設定對了——那正是 00 章六個事故的共同形狀。

```java
package com.example.lab09.ch03;

import com.example.lab09.Http;                       // 00 章 0.8.3 的裸 HTTP client

import java.net.http.HttpResponse;
import java.util.*;

/**
 * 一次打一整張「請求 × 帳號」的表，把狀態碼排成矩陣。
 * 授權設定的正確性【只能】用這種形狀檢查 —— 單看一格永遠看不出漏了什麼。
 */
public class Matrix {

    /** 四個帳號蓋掉三種角色，其中 alice 與 bob 是【同一個角色】—— 資源層授權要靠這兩個才測得出來 */
    public static final List<String> USERS = List.of("匿名", "alice", "bob", "cs", "admin");

    private final Http http;
    private final List<String> users;

    public Matrix(int port) { this(port, USERS); }
    public Matrix(int port, List<String> users) { this.http = new Http(port); this.users = users; }

    /** 中日文字算兩格寬，這樣表格在終端機才對得齊 */
    static String pad(String s, int width) {
        int w = 0;
        for (char c : s.toCharArray()) w += (c >= 0x1100 && c <= 0xFFE6) ? 2 : 1;
        return s + " ".repeat(Math.max(1, width - w));
    }

    public void print(String title, String... requests) {
        System.out.println("\n═══ " + title + " ═══");
        StringBuilder head = new StringBuilder(pad("請求", 36));
        for (String u : users) head.append(pad(u, 9));
        System.out.println(head);
        System.out.println("─".repeat(36 + 9 * users.size()));
        for (String req : requests) {
            String[] p = req.split(" ", 2);
            StringBuilder row = new StringBuilder(pad(req, 36));
            for (String u : users) {
                row.append(pad(String.valueOf(status(p[0], p[1], u)), 9));
            }
            System.out.println(row);
        }
    }

    public int status(String method, String path, String user) {
        return send(method, path, user).statusCode();
    }

    public HttpResponse<String> send(String method, String path, String user) {
        String auth = "匿名".equals(user) ? null : Http.basic(user, "pw");
        return http.send(method, path, null, "Authorization", auth);
    }
}
```

**第二個工具：授權規則表**（3.2.4 會解釋它是怎麼挖出來的）。
00 章 0.8.4 的 `SecurityChainReporter` 回答「請求會經過哪些 Filter」，
02 章 2.6.3 的 `AuthWiringReporter` 回答「誰在驗密碼」，
這一個回答第三個問題：**「`AuthorizationFilter` 手上到底有幾條規則、順序是什麼」**。

📌 **這三份輸出合起來，就是「我的安全設定到底長什麼樣」的完整答案。**

---

## 3.2 授權的三層，與 6.x 的新引擎

### 3.2.1 三層：URL、方法、資源

00 章 0.4.3 給過這張圖，這裡把它補完：

```
① URL 層     「這個【路徑】要什麼條件」
             .requestMatchers("/api/admin/**").hasRole("ADMIN")
             ▸ 在 Filter Chain 的【最後一個 Filter】裡做，Controller 還沒被呼叫
             ▸ 看得到：HTTP 方法、路徑、標頭、身分與 authorities
             ▸ 看不到：任何一筆資料
             ▸ 3.3

② 方法層     「這個【方法】要什麼條件」
             @PreAuthorize("hasAuthority('order:refund')")
             ▸ 在 Service / Controller 的方法上做，靠 AOP 代理
             ▸ 比 ① 多看得到：方法參數（#id）、以及【回傳值】（@PostAuthorize 的 returnObject）
             ▸ 3.5

③ 資源層     「這【筆資料】是不是你的」
             order.getOwnerUsername().equals(me.getName())
             ▸ 必須把資料撈出來（或把條件寫進查詢）才知道
             ▸ 它是【領域邏輯】，不是 Web 設定
             ▸ 3.8   ★ 最難的一層
```

⚠️ **三層不是替代關係，是三個【不同的問題】。**

一份設定良好的專案三層都會有，而且**每一層都往下收斂**：

```
URL 層     擋掉「這個角色連這個功能都碰不到」        —— 粗、便宜、擋得早
方法層     擋掉「這個功能裡的這個動作你不能做」      —— 中、要進 Spring 容器
資源層     擋掉「這個動作你可以做，但不是對這筆」    —— 細、要碰資料庫
```

📌 **一個判準**：

> **如果你把 Controller 整支刪掉、換一個新的 Controller 呼叫同一個 Service，
> 哪些檢查會跟著不見？** 不見的那些，就是放錯層了。

### 3.2.2 `AuthorizationFilter` 與 `AuthorizationManager`

01 章 1.4.2 列的 16 個 Filter 裡，**最後一個**是 `AuthorizationFilter`。
它的工作只有四行：

```java
// org.springframework.security.web.access.intercept.AuthorizationFilter（6.2.4，節錄）
AuthorizationDecision decision = this.authorizationManager.check(this::getAuthentication, request);
this.eventPublisher.publishAuthorizationEvent(this::getAuthentication, request, decision);
if (decision != null && !decision.isGranted()) {
    throw new AccessDeniedException("Access Denied");
}
chain.doFilter(request, response);
```

**四行裡有三件事值得記住**：

```
① 它把判斷【整個】委派給 AuthorizationManager —— Filter 自己不懂任何規則
② 身分是一個 Supplier<Authentication>，不是 Authentication
     → 規則如果用不到身分（例如 permitAll），SecurityContext 根本【不會被讀取】
③ 被擋下來時丟的是 AccessDeniedException —— 接手的是 ExceptionTranslationFilter（01 章 1.8.2）
```

**`AuthorizationManager` 的介面只有一個方法**：

```java
public interface AuthorizationManager<T> {
    AuthorizationDecision check(Supplier<Authentication> authentication, T object);
}
```

⚠️ **回傳值有三種可能，而第三種最容易被忽略**：

| 回傳 | 意思 | `AuthorizationFilter` 的反應 |
|---|---|---|
| `AuthorizationDecision(true)` | 准 | 放行 |
| `AuthorizationDecision(false)` | 不准 | 丟 `AccessDeniedException` |
| **`null`** | **「我不表示意見」** | **放行**（`decision != null` 那一段） |

📌 **`null` 等於放行**，這跟 02 章 2.4.1 `AuthenticationProvider` 回 `null` 的語意（「我不處理，換下一個」）
**看起來一樣、後果完全不同**：認證那邊還有下一個 provider 會接手，
授權這邊 `null` 之後**沒有人會再問一次**。

**內建的 `AuthorizationManager` 實作**（3.2.4 會把它們印出來）：

| 你寫的 | 實際上是 |
|---|---|
| `.permitAll()` | 一個永遠回 `granted=true` 的 lambda |
| `.denyAll()` | 一個永遠回 `granted=false` 的 lambda |
| `.authenticated()` | `AuthenticatedAuthorizationManager.authenticated()` |
| `.anonymous()` / `.rememberMe()` / `.fullyAuthenticated()` | 同一個類別的另外三個工廠方法 |
| `.hasRole("X")` / `.hasAuthority("X")` | `AuthorityAuthorizationManager` |
| `.access("...SpEL...")` | `WebExpressionAuthorizationManager` |
| `.access(自己寫的)` | 你自己那個 |

### 3.2.3 實測：每一次授權決策長什麼樣

**把每一條規則都用一層 lambda 包起來，把決策印出來**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.authorization.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.RequestAuthorizationContext;

/** 3.2 授權引擎的探針。 */
public class ProbeScenarios {

    /** p1：在內建的 AuthorizationManager 外面包一層，把每一次決策印出來 */
    @Configuration
    @Profile("p1")
    static class P1_DecisionProbe {

        static AuthorizationManager<RequestAuthorizationContext> probe(
                String label, AuthorizationManager<RequestAuthorizationContext> inner) {
            return (auth, ctx) -> {
                Authentication a = auth.get();
                AuthorizationDecision d = inner.check(auth, ctx);
                System.out.printf("   [%s] %-8s %-28s → %s%n",
                        label,
                        a == null ? "(null)" : a.getName(),
                        ctx.getRequest().getMethod() + " " + ctx.getRequest().getRequestURI(),
                        d == null ? "null（棄權）"
                                  : d.getClass().getSimpleName() + "(granted=" + d.isGranted() + ")  " + d);
                return d;
            };
        }

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/hello")
                        .access(probe("permitAll     ", (au, c) -> new AuthorizationDecision(true)))
                    .requestMatchers("/api/admin/**")
                        .access(probe("hasRole(ADMIN)", AuthorityAuthorizationManager.hasRole("ADMIN")))
                    .requestMatchers("/api/orders/{id}")
                        .access(probe("路徑變數        ", (au, ctx) -> {
                            String id = ctx.getVariables().get("id");     // ★ matcher 抓到的路徑變數
                            Authentication me = au.get();
                            boolean mine = "1001".equals(id) && "alice".equals(me.getName());
                            return new AuthorizationDecision(mine);
                        }))
                    .anyRequest()
                        .access(probe("authenticated ", AuthenticatedAuthorizationManager.authenticated())))
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "p1"})
class DecisionProbeTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void decisions() throws Exception {
        Matrix m = new Matrix(port);
        System.out.println("\n═══ 3.2.3 每一次授權決策長什麼樣 ═══");
        for (String[] c : new String[][]{
                {"GET", "/api/hello",         "匿名"},
                {"GET", "/api/admin/revenue", "alice"},
                {"GET", "/api/admin/revenue", "admin"},
                {"GET", "/api/orders/1001",   "alice"},
                {"GET", "/api/orders/1002",   "alice"},
                {"GET", "/api/reports/daily", "bob"}}) {
            System.out.printf("%n>> %s %s   （%s）%n", c[0], c[1], c[2]);
            int s = m.status(c[0], c[1], c[2]);
            System.out.println("   HTTP " + s);
            Thread.sleep(60);
        }
    }
}
```

**輸出**：

```
═══ 3.2.3 每一次授權決策長什麼樣 ═══

>> GET /api/hello   （匿名）
   [permitAll     ] anonymousUser GET /api/hello               → AuthorizationDecision(granted=true)  AuthorizationDecision [granted=true]
   HTTP 200

>> GET /api/admin/revenue   （alice）
   [hasRole(ADMIN)] alice    GET /api/admin/revenue       → AuthorityAuthorizationDecision(granted=false)  AuthorityAuthorizationDecision [granted=false, authorities=[ROLE_ADMIN]]
   [authenticated ] alice    GET /error                   → AuthorizationDecision(granted=true)  AuthorizationDecision [granted=true]
   HTTP 403

>> GET /api/admin/revenue   （admin）
   [hasRole(ADMIN)] admin    GET /api/admin/revenue       → AuthorityAuthorizationDecision(granted=true)  AuthorityAuthorizationDecision [granted=true, authorities=[ROLE_ADMIN]]
   HTTP 200

>> GET /api/orders/1001   （alice）
   [路徑變數        ] alice    GET /api/orders/1001         → AuthorizationDecision(granted=true)  AuthorizationDecision [granted=true]
   HTTP 200

>> GET /api/orders/1002   （alice）
   [路徑變數        ] alice    GET /api/orders/1002         → AuthorizationDecision(granted=false)  AuthorizationDecision [granted=false]
   [authenticated ] alice    GET /error                   → AuthorizationDecision(granted=true)  AuthorizationDecision [granted=true]
   HTTP 403

>> GET /api/reports/daily   （bob）
   [authenticated ] bob      GET /api/reports/daily       → AuthorizationDecision(granted=true)  AuthorizationDecision [granted=true]
   HTTP 200
```

**這份輸出回答了四個問題**：

**① 一個 403 的請求，`AuthorizationFilter` 跑了【兩次】。**

```
[hasRole(ADMIN)] alice  GET /api/admin/revenue  → granted=false
[authenticated ] alice  GET /error              → granted=true      ← 第二次
```

第二次是 **ERROR dispatch**（01 章 1.8.3）：403 由 `AccessDeniedHandler` 交給容器，
容器把請求重新 dispatch 到 `/error`，而**那一趟會再穿過一次 Filter Chain**。
📌 **所以 `/error` 一定要在授權規則裡有位置**——不然會發生 3.3.5 那個「400 變成 401」。

**② 被擋下來時，決策物件會告訴你「差什麼」。**

```
AuthorityAuthorizationDecision [granted=false, authorities=[ROLE_ADMIN]]
                                                ^^^^^^^^^^^^^^^^^^^^^^^^
```

`AuthorityAuthorizationDecision` 是 `AuthorizationDecision` 的子類，多帶了「需要哪些權限」。
**這是寫稽核日誌時最有價值的一個欄位**（3.2.5）。

**③ `ctx.getVariables()` 可以拿到路徑變數。**

```java
.requestMatchers("/api/orders/{id}")
    .access((au, ctx) -> {
        String id = ctx.getVariables().get("id");     // ← "1001"
        ...
    })
```

這是 URL 層唯一一個「碰得到資源識別碼」的入口。
⚠️ **但它仍然只是一個字串**——要判斷 1002 是不是 alice 的，還是得查資料庫，
而**在 Filter 裡查資料庫**會讓你在 3.8.3 之外多開一條資料存取路徑。
📌 **本課的建議**：`getVariables()` 用來做**便宜的**比對（例如「路徑上的 userId 必須等於 `authentication.name`」），
真的要查資料的，往下一層放。

**④ `permitAll` 那一格印的是 `anonymousUser`，不是 `null`。**

因為 `AnonymousAuthenticationFilter`（16 個裡的第 10 個）已經塞了一個
`AnonymousAuthenticationToken` 進去。**「沒登入」在 Spring Security 裡不是 `null`，是一個叫 `anonymousUser` 的身分。**
這就是為什麼 `.anonymous()` 這條規則存在（3.3.6）。

### 3.2.4 實測：把授權規則表印出來

**規則清單藏在 `AuthorizationFilter` → `RequestMatcherDelegatingAuthorizationManager` 的一個私有欄位裡。**
挖出來就是一份「這個服務到底有哪些授權規則」的完整清單：

```java
package com.example.lab09.ch03;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Profile;
import org.springframework.security.authorization.AuthorizationManager;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.access.intercept.RequestMatcherDelegatingAuthorizationManager;
import org.springframework.security.web.util.matcher.RequestMatcherEntry;
import org.springframework.stereotype.Component;

import java.lang.reflect.Field;
import java.util.List;

/**
 * 啟動時把【每一條授權規則】印出來：matcher → 由誰決定。
 * 00 章 0.8.4 的 SecurityChainReporter 回答「請求會經過哪些 Filter」，
 * 這一個回答「AuthorizationFilter 手上到底有幾條規則、順序是什麼」。
 */
@Component
@Profile("!prod")
public class AuthzRuleReporter implements ApplicationListener<ApplicationReadyEvent> {

    private final FilterChainProxy proxy;
    public AuthzRuleReporter(FilterChainProxy proxy) { this.proxy = proxy; }

    @Override
    public void onApplicationEvent(ApplicationReadyEvent e) { print(); }

    public void print() {
        System.out.println("\n──────── 授權規則表（AuthorizationFilter 的內容）────────");
        int c = 0;
        for (SecurityFilterChain chain : proxy.getFilterChains()) {
            System.out.printf("chain[%d]  %s%n", c++, chain);
            AuthorizationFilter af = chain.getFilters().stream()
                    .filter(AuthorizationFilter.class::isInstance)
                    .map(AuthorizationFilter.class::cast)
                    .findFirst().orElse(null);
            if (af == null) { System.out.println("   （這條 chain 上沒有 AuthorizationFilter）"); continue; }

            AuthorizationManager<?> am = af.getAuthorizationManager();
            if (!(am instanceof RequestMatcherDelegatingAuthorizationManager d)) {
                System.out.println("   （不是 RequestMatcherDelegating…，而是 " + am.getClass().getSimpleName() + "）");
                continue;
            }
            int i = 0;
            for (RequestMatcherEntry<? extends AuthorizationManager<?>> m : mappings(d))
                System.out.printf("   規則 %d  %-58s → %s%n", i++, m.getRequestMatcher(), describe(m.getEntry()));
            System.out.println("   （沒有命中任何一條規則 → DENY）");
        }
        System.out.println("─────────────────────────────────────────────────────────\n");
    }

    @SuppressWarnings("unchecked")
    static List<RequestMatcherEntry<? extends AuthorizationManager<?>>> mappings(
            RequestMatcherDelegatingAuthorizationManager d) {
        try {
            Field f = RequestMatcherDelegatingAuthorizationManager.class.getDeclaredField("mappings");
            f.setAccessible(true);
            return (List<RequestMatcherEntry<? extends AuthorizationManager<?>>>) f.get(d);
        } catch (ReflectiveOperationException ex) { throw new IllegalStateException(ex); }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    static String describe(Object am) {
        String s = String.valueOf(am);
        if (am instanceof org.springframework.security.authorization.AuthenticatedAuthorizationManager)
            return "authenticated() / anonymous() / fullyAuthenticated()";
        if (!s.contains("$$Lambda")) return s;
        // permitAll() / denyAll() 是 lambda，toString 只會印出亂碼 —— 直接問它一次
        try {
            Object d = ((AuthorizationManager) am).check(() -> null, null);
            if (d instanceof org.springframework.security.authorization.AuthorizationDecision ad)
                return ad.isGranted() ? "permitAll()（常數 granted=true）" : "denyAll()（常數 granted=false）";
        } catch (Exception ignore) { }
        return "（lambda / 自訂 AuthorizationManager）" + am.getClass().getName();
    }
}
```

**對著 3.3.7 那份設定（profile `u4`）跑出來的結果**：

```
──────── 授權規則表（AuthorizationFilter 的內容）────────
chain[0]  DefaultSecurityFilterChain [RequestMatcher=any request, Filters=[…13 個…]]
   規則 0  Mvc [pattern='/api/hello']                                 → permitAll()（常數 granted=true）
   規則 1  Mvc [pattern='/api/admin/**']                              → AuthorityAuthorizationManager[authorities=[ROLE_ADMIN]]
   規則 2  Mvc [pattern='/api/orders/*/refund', POST]                 → AuthorityAuthorizationManager[authorities=[order:refund]]
   規則 3  Mvc [pattern='/api/orders/**', DELETE]                     → AuthorityAuthorizationManager[authorities=[ROLE_ADMIN]]
   規則 4  any request                                                → authenticated() / anonymous() / fullyAuthenticated()
   （沒有命中任何一條規則 → DENY）
─────────────────────────────────────────────────────────
```

**這份輸出解決三件事**：

```
① 規則的【真實順序】—— 不是你在程式碼裡看到的順序，是引擎手上那份 list 的順序
② 每一條規則要求的【實際字串】—— 規則 1 要的是 "ROLE_ADMIN"，那個前綴看得見（3.4）
③ 最後一行「沒有命中任何一條規則 → DENY」—— 3.3.7 會用實測確認這句話
```

⚠️ **`Mvc [pattern=…]` 這個字樣值得注意。**
你寫 `requestMatchers("/api/admin/**")` 時，Spring Security 6.2 在
**classpath 上有 Spring MVC** 的情況下建的是 `MvcRequestMatcher`，
它用的是 **Spring MVC 的比對規則**，不是單純的字串比對——
3.3.5 會用八個路徑量出這件事的後果。

### 3.2.5 實測：授權事件

**6.x 內建一個事件發佈器，但預設是關的。** 打開它只要宣告一個 bean：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.context.event.EventListener;
import org.springframework.security.authorization.*;
import org.springframework.security.authorization.event.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.RequestAuthorizationContext;

import java.util.function.Supplier;

public class AuthzEventScenario {

    /** p2：授權事件 —— 6.x 內建的 publisher 會發什麼、不會發什麼 */
    @Configuration
    @Profile("p2")
    static class P2_Events {

        @Bean AuthorizationEventPublisher authorizationEventPublisher(
                org.springframework.context.ApplicationEventPublisher pub) {
            return new SpringAuthorizationEventPublisher(pub);        // ★ 只要這一個 bean
        }

        @Bean AuthzEventLog authzEventLog() { return new AuthzEventLog(); }

        static class AuthzEventLog {
            @EventListener
            void onDenied(AuthorizationDeniedEvent<?> e) {
                System.out.printf("   ❌ AuthorizationDeniedEvent  who=%-8s object=%s%n",
                        name(e.getAuthentication()), shorten(e.getObject()));
            }
            @EventListener
            void onGranted(AuthorizationGrantedEvent<?> e) {
                System.out.printf("   ✅ AuthorizationGrantedEvent who=%-8s object=%s%n",
                        name(e.getAuthentication()), shorten(e.getObject()));
            }
            static String name(Supplier<Authentication> s) {
                Authentication a = s.get();
                return a == null ? "(null)" : a.getName();
            }
            static String shorten(Object o) {
                if (o instanceof RequestAuthorizationContext c) o = c.getRequest();
                if (o instanceof jakarta.servlet.http.HttpServletRequest r)
                    return r.getMethod() + " " + r.getRequestURI() + "   (" + o.getClass().getSimpleName() + ")";
                return String.valueOf(o);
            }
        }

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/hello").permitAll()
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**把「通過」與「被擋」各打幾次**（`Matrix` 是 3.1.2 那個工具）：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "p2"})
class AuthzEventTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void events() throws Exception {
        Matrix m = new Matrix(port);
        System.out.println("\n═══ 3.2.5 授權事件：哪些會發、哪些不會 ═══");
        for (String[] c : new String[][]{
                {"GET", "/api/hello",         "匿名",  "permitAll，通過"},
                {"GET", "/api/orders/1001",   "alice", "authenticated，通過"},
                {"GET", "/api/admin/revenue", "admin", "hasRole(ADMIN)，通過"},
                {"GET", "/api/admin/revenue", "alice", "hasRole(ADMIN)，被擋"},
                {"GET", "/api/admin/revenue", "匿名",  "hasRole(ADMIN)，匿名"}}) {
            System.out.printf("%n>> %s %s   （%s：%s）%n", c[0], c[1], c[2], c[3]);
            System.out.println("   HTTP " + m.status(c[0], c[1], c[2]));
            Thread.sleep(80);      // ★ 事件是 listener 印的，睡一下才不會跟下一列交錯
        }
    }
}
```

**輸出**：

```
═══ 3.2.5 授權事件：哪些會發、哪些不會 ═══

>> GET /api/hello   （匿名：permitAll，通過）
   HTTP 200

>> GET /api/orders/1001   （alice：authenticated，通過）
   HTTP 200

>> GET /api/admin/revenue   （admin：hasRole(ADMIN)，通過）
   HTTP 200

>> GET /api/admin/revenue   （alice：hasRole(ADMIN)，被擋）
   ❌ AuthorizationDeniedEvent  who=alice    object=GET /api/admin/revenue   (Servlet3SecurityContextHolderAwareRequestWrapper)
   HTTP 403

>> GET /api/admin/revenue   （匿名：hasRole(ADMIN)，匿名）
   ❌ AuthorizationDeniedEvent  who=anonymousUser object=GET /api/admin/revenue   (Servlet3SecurityContextHolderAwareRequestWrapper)
   ❌ AuthorizationDeniedEvent  who=anonymousUser object=GET /error   (Servlet3SecurityContextHolderAwareRequestWrapper)
   HTTP 401
```

**三個必須知道的事實**：

**① `AuthorizationGrantedEvent` 一次都沒有發。**

```java
// SpringAuthorizationEventPublisher（6.2.4）
public void publishAuthorizationEvent(Supplier<Authentication> authentication,
        T object, AuthorizationDecision decision) {
    if (decision == null || decision.isGranted()) {
        return;                                  // ★ 通過的就直接 return
    }
    ...publishEvent(new AuthorizationDeniedEvent<>(authentication, object, decision));
}
```

**內建的 publisher 只發「被拒絕」。** 要記錄「誰在什麼時候讀了什麼」（稽核，08 章），
得自己實作 `AuthorizationEventPublisher`——
⚠️ **而那會在【每一個請求】上多做一次事件發佈**，包含靜態資源。

**② 一個 401 會發【兩個】拒絕事件。**

第二個是 `/error` 的 ERROR dispatch（3.2.3 的發現①）。
**如果你把這個事件接去寫稽核日誌或觸發告警，記得去重**——
不然一次未授權存取會在你的告警系統裡變成兩筆。

**③ 事件的 `getObject()` 是 `HttpServletRequest`，不是 `RequestAuthorizationContext`。**

型別是 `AuthorizationDeniedEvent<?>`，那個 `?` 在 URL 層是 request、
在方法層是 `MethodInvocation`。**寫 listener 時一定要 `instanceof` 分流。**

---

## 3.3 URL 層：`authorizeHttpRequests`

### 3.3.1 規則是一條 list，由上而下、第一個命中就決定

3.2.4 那份輸出已經洩漏了答案：**規則不是一個 map，是一條有順序的 list。**

```
請求進來
   ↓
規則 0 的 matcher 比對成功嗎？ ── 是 ──▸ 用規則 0 的 AuthorizationManager 決定，【結束】
   ↓ 否
規則 1 的 matcher 比對成功嗎？ ── 是 ──▸ 用規則 1 決定，【結束】
   ↓ 否
   …
   ↓ 全部都不命中
DENY
```

**三條直接推論出來的規則**：

```
① 越【具體】的規則要寫在越前面 —— 因為第一個命中就結束了
② anyRequest() 一定是最後一條 —— 它命中所有東西
③ 一條規則命中之後，後面的規則【不會】再被評估 —— 沒有「兩條規則都要滿足」這種事
```

⚠️ **第 ③ 點常被誤解。** 下面這段設定**不是**「要 ADMIN 而且要登入」：

```java
.requestMatchers("/api/admin/**").hasRole("ADMIN")
.requestMatchers("/api/admin/**").authenticated()      // ← 這一行是死的
```

要「兩個條件都滿足」，得寫在**同一條規則**裡：

```java
.requestMatchers("/api/admin/**").access(allOf(
        AuthorityAuthorizationManager.hasRole("ADMIN"),
        AuthenticatedAuthorizationManager.fullyAuthenticated()))
```

📌 `AuthorizationManagers.allOf(...)` / `anyOf(...)` / `not(...)` 是 6.0 起的內建組合子
（`org.springframework.security.authorization.AuthorizationManagers`）。

### 3.3.2 實測：順序寫反的兩種結局

**寫反有兩種結局，而它們的嚴重程度天差地遠。**

**結局一：靜默失效。** 廣的規則寫在前面，後面那條**永遠不會被評估**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

public class U1Scenario {

    /** u1：🔴 規則順序寫反 —— 廣的規則寫在前面，後面那條永遠不會被看到 */
    @Configuration
    @Profile("u1")
    static class U1_WrongOrder {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/**").authenticated()               // ← 先命中
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")        // ← 永遠到不了
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**用 3.1.2 的 `Matrix` 打一整張表**——一次只打一格，是看不出這個洞的：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "u1"})          // ← u1 就是上面那個寫反的設定
class UrlRuleTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void wrongOrder() {
        System.out.println("\n═══ 3.3.2 規則順序寫反：/api/** 寫在 /api/admin/** 前面 ═══");
        new Matrix(port).print("u1：alice 是 ROLE_USER，admin 是 ROLE_ADMIN",
                "GET /api/hello",
                "GET /api/orders/1001",
                "GET /api/admin/revenue",
                "GET /api/admin/users");
    }
}
```

```
═══ 3.3.2 規則順序寫反：/api/** 寫在 /api/admin/** 前面 ═══

═══ u1：alice 是 ROLE_USER，admin 是 ROLE_ADMIN ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/hello                      401      200      200      200      200
GET /api/orders/1001                401      200      200      200      200
GET /api/admin/revenue              401      200      200      200      200
GET /api/admin/users                401      200      200      200      200
```

⚠️ **`/api/admin/revenue` 那一列：alice 拿到 200。**
`hasRole("ADMIN")` 那一行**一次都沒有被評估過**，而且：

```
啟動不會報錯
不會有任何 WARN
IDE 不會提示
只有 3.2.4 那份規則表看得出來（它會照原順序印）
```

📌 **這就是為什麼要有規則表。** 順序錯誤是**看不出來**的，除非你把 list 印出來。

**結局二：啟動就失敗。** `anyRequest()` 之後再加規則：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

public class U2Scenario {

    /** u2：🔴 anyRequest() 寫在中間 —— 這一條【啟動就會失敗】 */
    @Configuration
    @Profile("u2")
    static class U2_AnyRequestInMiddle {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .anyRequest().authenticated()
                    .requestMatchers("/api/admin/**").hasRole("ADMIN"))
                .httpBasic(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

```java
package com.example.lab09.ch03;

import com.example.lab09.LabApp;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

class U2AnyRequestTest {

    @Test
    void anyRequestInMiddleFailsAtStartup() {
        System.out.println("\n═══ 3.3.2 anyRequest() 寫在中間 —— 啟動就失敗 ═══");
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(LabApp.class)
                .web(WebApplicationType.SERVLET)
                .profiles("db", "ch3", "u2")
                .properties("server.port=0", "spring.main.banner-mode=off",
                            "logging.level.root=OFF")
                .run()) {
            System.out.println("🔴 竟然啟動成功了？");
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            System.out.println("✅ 啟動失敗，最深層的例外是：");
            System.out.println("   " + root.getClass().getName());
            System.out.println("   " + root.getMessage());
        }
    }
}
```

```
═══ 3.3.2 anyRequest() 寫在中間 —— 啟動就失敗 ═══
✅ 啟動失敗，最深層的例外是：
   java.lang.IllegalStateException
   Can't configure mvcMatchers after anyRequest
```

**兩種結局的對照**：

| | 結局一（`/api/**` 在前） | 結局二（`anyRequest()` 在中間） |
|---|---|---|
| 什麼時候發現 | **上線後被人打進來才發現** | 啟動就失敗 |
| 訊息 | 沒有 | `Can't configure mvcMatchers after anyRequest` |
| Spring 為什麼只擋一種 | 它只擋得住「明確標記為 anyRequest 之後」——它**無法知道** `/api/**` 涵蓋 `/api/admin/**` | |

⚠️ **Spring 幫你擋的是「你一定寫錯了」的那一種**，
「你可能寫錯了」的那一種它管不了——**那是你的規則表與矩陣測試的工作**。

### 3.3.3 `requestMatchers` 的三種比對

```java
// ① 只比路徑
.requestMatchers("/api/admin/**")

// ② 路徑 + HTTP 方法（★ 3.3.4 會證明這個有多重要）
.requestMatchers(HttpMethod.POST, "/api/orders")

// ③ 自己給一個 RequestMatcher
.requestMatchers(new RegexRequestMatcher("^/api/v[0-9]+/admin/.*$", null))
.requestMatchers(request -> request.getHeader("X-Internal") != null)
```

**路徑樣式的規則**（Ant 風格，`AntPathMatcher` / `PathPattern`）：

| 樣式 | 比對到 | 比對**不**到 |
|---|---|---|
| `/api/orders` | `/api/orders` | `/api/orders/1`、`/api/orders/` |
| `/api/orders/*` | `/api/orders/1` | `/api/orders`、`/api/orders/1/items` |
| `/api/orders/**` | `/api/orders`、`/api/orders/1`、`/api/orders/1/items` | `/api/orderx` |
| `/api/*/refund` | `/api/1/refund` | `/api/a/b/refund` |
| `/api/orders/{id}` | `/api/orders/1`（並且 `id` 可以在 `.access()` 裡拿到，3.2.3） | |

⚠️ **`/api/orders` 與 `/api/orders/**` 不是同一件事**，這是最常見的一個漏洞來源：

```java
.requestMatchers("/api/admin").hasRole("ADMIN")        // 🔴 只保護了【一個】路徑
// /api/admin/users、/api/admin/settings … 全部沒有被這條規則涵蓋
```

📌 **判準：只要那個前綴底下【將來】會長出新端點，就要寫 `/**`。**

### 3.3.4 🔴 實測：規則只寫了 GET

**這是本章第一個「程式碼看起來完全正確」的事故。**

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

public class U3Scenario {

    /** u3：🔴 只寫了 GET 的規則 —— POST / DELETE 從旁邊走過去 */
    @Configuration
    @Profile("u3")
    static class U3_MethodForgotten {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers(HttpMethod.GET, "/api/admin/**").hasRole("ADMIN")
                    .requestMatchers(HttpMethod.GET, "/api/orders/**").authenticated()
                    .anyRequest().permitAll())                                // ← 兇手在這裡
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**矩陣的「請求」欄這次一定要寫成「方法 + 路徑」**——
只列路徑的話，下面第二列與第四列**根本不會出現在表上**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "u3"})
class U3MethodTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void methodForgotten() {
        System.out.println("\n═══ 3.3.4 規則只寫了 GET ═══");
        new Matrix(port).print(
                "u3：requestMatchers(GET, \"/api/admin/**\").hasRole(\"ADMIN\") + anyRequest().permitAll()",
                "GET /api/admin/users",
                "POST /api/admin/users",          // ★ 同一個路徑，只換了方法
                "GET /api/orders/1001",
                "DELETE /api/orders/1001",        // ★ 同上
                "POST /api/orders");
    }
}
```

```
═══ 3.3.4 規則只寫了 GET ═══

═══ u3：requestMatchers(GET, "/api/admin/**").hasRole("ADMIN") + anyRequest().permitAll() ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/admin/users                401      403      403      403      200
POST /api/admin/users               200      200      200      200      200
GET /api/orders/1001                401      200      200      200      200
DELETE /api/orders/1001             204      204      204      204      204
POST /api/orders                    200      200      200      200      200
```

**第二列與第四列**：

```
POST   /api/admin/users   匿名 → 200      ← 沒登入就能建管理員帳號
DELETE /api/orders/1001   匿名 → 204      ← 沒登入就能刪訂單
```

⚠️ **這個洞為什麼躲得過測試？**

```
① 手動測試都是用瀏覽器點的 —— 瀏覽器點出來的幾乎都是 GET
② 整合測試只寫「該通過的通過」，很少寫「匿名 POST 應該被擋」
③ Swagger / Postman 測的是「功能對不對」，不是「未授權的人能不能打」
④ 授權矩陣如果只列 GET，這一格根本不在表上
```

📌 **兩條可以直接寫進 code review 清單的規則**：

```
規則一：授權矩陣的「請求」欄一律寫成「方法 + 路徑」，不能只寫路徑。
規則二：anyRequest() 的內容【只有兩種可以接受】：
        .authenticated()   —— 預設要登入
        .denyAll()         —— 預設全擋（更嚴格，適合純內部服務）
        🔴 .permitAll() 幾乎永遠是錯的 —— 它把「忘了寫規則」變成「公開端點」
```

**同一份設定，把 `anyRequest().permitAll()` 換成 `.authenticated()`**，
第二列與第四列就會變成 401。**這一個字的差別，就是 00 章事故二。**

### 3.3.5 🔴 實測：同一支端點的八種寫法

**規則寫的是 `/api/admin/**`。攻擊者不會照著你的字串打。**

```java
package com.example.lab09.ch03;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "u4"})
class PathNormalisationTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void pathNormalisation() {
        System.out.println("\n═══ 3.3.5 同一支端點的八種寫法，安全規則都跟得上嗎 ═══");
        Matrix m = new Matrix(port);
        String[][] cases = {
                {"/api/admin/revenue",           "原樣"},
                {"/api/admin/revenue/",          "多一個尾斜線"},
                {"/API/ADMIN/REVENUE",           "全大寫"},
                {"/api/admin/revenue;x=1",       "路徑參數（; 開頭）"},
                {"//api/admin/revenue",          "兩個斜線開頭"},
                {"/api/./admin/revenue",         "路徑裡有 ."},
                {"/api/orders/../admin/revenue", "路徑裡有 .."},
                {"/api/admin/%72evenue",         "把 r 換成 %72"},
        };
        System.out.printf("%n%-32s %-24s %-10s %-10s%n", "路徑", "說明", "alice", "admin");
        System.out.println("─".repeat(82));
        for (String[] c : cases) {
            HttpResponse<String> a = m.send("GET", c[0], "alice");
            HttpResponse<String> b = m.send("GET", c[0], "admin");
            System.out.printf("%-32s %-24s %-10d %-10d%n",
                    c[0], c[1], a.statusCode(), b.statusCode());
        }
    }
}
```

```
═══ 3.3.5 同一支端點的八種寫法，安全規則都跟得上嗎 ═══

路徑                               說明                       alice      admin
──────────────────────────────────────────────────────────────────────────────────
/api/admin/revenue               原樣                       403        200
/api/admin/revenue/              多一個尾斜線                   403        404
/API/ADMIN/REVENUE               全大寫                      404        404
/api/admin/revenue;x=1           路徑參數（; 開頭）               401        401
//api/admin/revenue              兩個斜線開頭                   401        401
/api/./admin/revenue             路徑裡有 .                   401        401
/api/orders/../admin/revenue     路徑裡有 ..                  401        401
/api/admin/%72evenue             把 r 換成 %72               403        200
```

**一列一列讀**：

| 路徑 | alice | 判讀 |
|---|---|---|
| 原樣 | 403 | 正常 |
| 尾斜線 | **403** | ✅ 安全規則有跟上；admin 拿到 404 是因為 **Spring Framework 6 起預設不做尾斜線比對**，MVC 找不到 handler |
| 全大寫 | 404 | ⚠️ 安全規則**沒有**命中（掉到 `anyRequest().authenticated()`，alice 通過了），只是 MVC 也找不到端點 |
| `;x=1` / `//` / `.` / `..` | **401** | 被 `StrictHttpFirewall` 擋掉——但**狀態碼不是 400**，見下 |
| `%72` | 403 | ✅ Spring 會先解碼再比對，所以規則跟得上 |

⚠️ **「全大寫」那一列是一個提醒**：

```
路徑比對是【區分大小寫】的。
這次沒出事，是因為 Spring MVC 的 handler 也區分大小寫（找不到 → 404）。
🔴 但如果你的服務前面有一台會做 case-insensitive 轉發的 gateway，
   或者你自己寫了一個大小寫不敏感的 handler，這一格就會變成【200】。
```

**現在來看那四個 401。** 它們**不是**認證失敗——`admin:pw` 是正確的憑證。
打開 `DEBUG` 日誌就看得到真相：

```
DEBUG s.s.w.f.HttpStatusRequestRejectedHandler : Rejecting request due to:
      The request was rejected because the URL contained a potentially malicious String ";"
      org.springframework.security.web.firewall.RequestRejectedException
        at StrictHttpFirewall.rejectedBlocklistedUrls(StrictHttpFirewall.java:539)
DEBUG o.s.security.web.FilterChainProxy        : Securing GET /error          ← ★ ERROR dispatch
DEBUG o.s.s.w.a.AnonymousAuthenticationFilter  : Set SecurityContextHolder to anonymous SecurityContext
```

**事情的完整經過**：

```
① StrictHttpFirewall 拒絕請求（它在 FilterChainProxy 的【最前面】，比所有 Filter 都早）
② HttpStatusRequestRejectedHandler 把回應設成 400
③ 容器做 ERROR dispatch 到 /error
④ 這一趟【重新穿過 Filter Chain】
⑤ BasicAuthenticationFilter 是 OncePerRequestFilter，預設【跳過 ERROR dispatch】
     → 這一趟沒有人認證 → AnonymousAuthenticationFilter 塞進匿名身分
⑥ /error 沒有被 permitAll，anyRequest().authenticated() 把匿名擋掉
⑦ 最終回應：401
```

**把 `/error` 放行，同一組請求的真實狀態碼就會浮出來**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

public class U7Scenario {

    /** u7：跟 3.3.7 的 u4 一模一樣，只多了一行 —— 把 /error 放行（01 章 1.8.3） */
    @Configuration
    @Profile("u7")
    static class U7_ErrorPermitted {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()                    // ← 只多這一行
                    .requestMatchers("/api/hello").permitAll()
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/orders/*/refund").hasAuthority("order:refund")
                    .requestMatchers(HttpMethod.DELETE, "/api/orders/**").hasRole("ADMIN")
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**同一組路徑再打一次**。這次不用 `Matrix`——要看的是**回應內容**，不只是狀態碼：

```java
package com.example.lab09.ch03;

import com.example.lab09.Http;                  // 00 章 0.8.3
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "u7"})
class U7ErrorPermittedTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void firewallStatusWithErrorPermitted() {
        System.out.println("\n═══ 3.3.5 把 /error 放行之後，防火牆的真實狀態碼 ═══");
        Http http = new Http(port);
        // ★ 帶的是【正確的】憑證 —— 所以下面那四個回應絕對不是認證失敗
        for (String p : new String[]{"/api/admin/revenue;x=1", "//api/admin/revenue",
                "/api/./admin/revenue", "/api/orders/../admin/revenue"}) {
            HttpResponse<String> r = http.get(p, "Authorization", Http.basic("admin", "pw"));
            String b = r.body() == null ? "" : r.body().replace("\n", " ");
            if (b.length() > 110) b = b.substring(0, 110) + "…";
            System.out.printf("%-32s → %d  %s%n", p, r.statusCode(), b);
        }
    }
}
```

```
═══ 3.3.5 把 /error 放行之後，防火牆的真實狀態碼 ═══
/api/admin/revenue;x=1           → 400  {"timestamp":"…","status":400,"error":"Bad Request","path":"/api/admin/revenue;x=1"}
//api/admin/revenue              → 400  {"timestamp":"…","status":400,"error":"Bad Request","path":"//api/admin/revenue"}
/api/./admin/revenue             → 400  {"timestamp":"…","status":400,"error":"Bad Request","path":"/api/./admin/revenue"}
/api/orders/../admin/revenue     → 400  {"timestamp":"…","status":400,"error":"Bad Request","path":"/api/orders/../admin/revenue"}
```

📌 **三個結論**：

```
① StrictHttpFirewall 預設就會擋掉 ; // . .. %2f 這些「路徑正規化」攻擊 —— 這是 Spring 幫你做的
② 🔴 /error 沒有 permitAll 的話，防火牆的 400 會被【蓋成 401】
     → 你在 log 裡看到一堆 401，會以為是「有人密碼打錯」，其實是路徑攻擊
③ 01 章 1.8.3 說「403 會走 /error」，這裡是同一件事的第二個症狀
```

⚠️ **不要為了「讓那個路徑能動」去關掉防火牆。**
`StrictHttpFirewall#setAllowUrlEncodedSlash(true)` 這類設定會**打開真正的洞**。
如果是舊系統的路徑真的帶 `;`，改路徑，不要改防火牆。

### 3.3.6 實測：五個內建規則的真實行為

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

public class U5Scenario {

    /** u5：五個「內建規則」的對照組 */
    @Configuration
    @Profile("u5")
    static class U5_BuiltinRules {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/hello").permitAll()
                    .requestMatchers("/api/echo").denyAll()
                    .requestMatchers("/api/reports/**").anonymous()
                    .requestMatchers("/api/orders/**").authenticated()
                    .requestMatchers("/api/admin/**").fullyAuthenticated()
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .rememberMe(r -> r.key("lab09").alwaysRemember(true))
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**實測**（先用表單登入拿到 `JSESSIONID` 與 `remember-me` 兩個 cookie，再分別只帶其中一個）：

```java
package com.example.lab09.ch03;

import com.example.lab09.Http;                  // 00 章 0.8.3
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.regex.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "u5"})
class U5BuiltinTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void builtinRules() {
        System.out.println("\n═══ 3.3.6 五個內建規則，三種身分 ═══");
        Http http = new Http(port);

        // ① 表單登入一次，同時拿到 JSESSIONID 與 remember-me 兩個 cookie
        //    （設定裡寫了 alwaysRemember(true)，所以不用勾「記住我」）
        HttpResponse<String> page = http.get("/login");
        Matcher m = Pattern.compile("name=\"_csrf\".*?value=\"([^\"]+)\"").matcher(page.body());
        String csrf = m.find() ? m.group(1) : "";
        String session = cookie(page, "JSESSIONID");
        HttpResponse<String> login = http.send("POST", "/login",
                "username=alice&password=pw&_csrf=" + csrf,
                "Content-Type", "application/x-www-form-urlencoded",
                "Cookie", "JSESSIONID=" + session);
        String full = cookie(login, "JSESSIONID");
        String remember = cookie(login, "remember-me");
        System.out.println("表單登入 → " + login.statusCode()
                + "  remember-me cookie = " + (remember == null ? "（沒有）" : remember.substring(0, 12) + "…"));

        // ② 三種身分各打一次：不帶 cookie（匿名）、只帶 JSESSIONID（完整登入）、
        //    只帶 remember-me ★ 最後這一欄才分得出 authenticated 與 fullyAuthenticated
        String[][] paths = {
                {"/api/hello",         "permitAll()"},
                {"/api/echo",          "denyAll()"},
                {"/api/reports/daily", "anonymous()"},
                {"/api/orders/1001",   "authenticated()"},
                {"/api/admin/revenue", "fullyAuthenticated()"},
        };
        System.out.printf("%n%-22s %-22s %-12s %-16s %-16s%n",
                "路徑", "規則", "匿名", "完整登入(alice)", "只帶 remember-me");
        System.out.println("─".repeat(92));
        for (String[] p : paths) {
            int anon = http.get(p[0]).statusCode();
            int sess = http.get(p[0], "Cookie", "JSESSIONID=" + full).statusCode();
            int rem  = http.get(p[0], "Cookie", "remember-me=" + remember).statusCode();
            System.out.printf("%-22s %-22s %-12d %-16d %-16d%n", p[0], p[1], anon, sess, rem);
        }
    }

    /** 從 Set-Cookie 標頭挑出某個 cookie 的值（登出用的空值要跳過） */
    static String cookie(HttpResponse<String> r, String name) {
        return r.headers().allValues("set-cookie").stream()
                .filter(c -> c.startsWith(name + "="))
                .map(c -> c.substring(name.length() + 1).split(";")[0])
                .filter(v -> !v.isEmpty())
                .findFirst().orElse(null);
    }
}
```

```
═══ 3.3.6 五個內建規則，三種身分 ═══
表單登入 → 302  remember-me cookie = YWxpY2U6MTc5…

路徑                     規則                     匿名           完整登入(alice)      只帶 remember-me
────────────────────────────────────────────────────────────────────────────────────────────
/api/hello             permitAll()            200          200              200
/api/echo              denyAll()              401          403              401
/api/reports/daily     anonymous()            200          403              401
/api/orders/1001       authenticated()        401          200              200
/api/admin/revenue     fullyAuthenticated()   401          200              401
```

**五個規則的定義**：

| 規則 | 通過條件 | 典型用途 |
|---|---|---|
| `permitAll()` | 永遠通過 | 登入頁、健康檢查、公開 API |
| `denyAll()` | 永遠不通過 | 「這支端點還沒開放」「這支端點只給內部呼叫」 |
| `anonymous()` | **只有**匿名通過 | 註冊頁、登入頁——**已登入的人不該再看到** |
| `authenticated()` | 匿名以外都通過（含 remember-me） | 絕大多數端點 |
| `fullyAuthenticated()` | 只有**真的輸入過憑證**的通過 | 改密碼、改綁定信箱、下大額訂單 |

**這張表裡有三格值得單獨解釋**：

**① `denyAll()`：匿名拿到 401，登入的人拿到 403。**

同一條規則、同樣「不通過」，狀態碼卻不同。
原因是 01 章 1.8.2 那段 `ExceptionTranslationFilter` 的邏輯：

```
AccessDeniedException 冒出來
   ↓
目前是匿名 / remember-me ？
   ├─ 是 → 「你可能只是還沒【好好】登入」→ AuthenticationEntryPoint → 401
   └─ 否 → 「你真的沒權限」            → AccessDeniedHandler      → 403
```

**② `fullyAuthenticated()`：只帶 remember-me 的人拿到 401，不是 403。**

同上——`AuthenticationTrustResolver.isRememberMe()` 為真時，
`ExceptionTranslationFilter` **給他一個重新登入的機會**。
📌 **這個設計是對的**：前端收到 401 會跳登入頁，使用者輸入密碼後就通過了。
如果回 403，使用者會看到「你沒有權限」——但他其實只要重新登入就可以。

**③ `anonymous()`：登入的人拿到 403。**

```java
.requestMatchers("/login", "/register").anonymous()
```

這是「已登入的人不該再看到註冊頁」的寫法。
⚠️ **但 403 對使用者不友善**——比較好的做法是在 `AccessDeniedHandler` 裡把他導回首頁。

### 3.3.7 實測：一份寫對的設定，長什麼樣

**把 3.3.2～3.3.6 的教訓全部套上去**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

public class U4Scenario {

    /** u4：順序正確、HTTP 方法有寫、anyRequest 兜底 */
    @Configuration
    @Profile("u4")
    static class U4_Correct {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/hello").permitAll()
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/orders/*/refund").hasAuthority("order:refund")
                    .requestMatchers(HttpMethod.DELETE, "/api/orders/**").hasRole("ADMIN")
                    .anyRequest().authenticated())                            // ← 兜底，永遠寫在最後
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**驗收的方式也固定下來：八個「方法 + 路徑」× 五個帳號，一次打完**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "u4"})
class U4CorrectTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void correctRules() {
        System.out.println("\n═══ 3.3.7 五條規則的完整授權矩陣 ═══");
        new Matrix(port).print("u4：順序正確、HTTP 方法有寫、anyRequest 兜底",
                "GET /api/hello",
                "GET /api/orders/1001",
                "POST /api/orders",
                "POST /api/orders/1001/refund",     // ★ 只有帶 order:refund 的人過得去
                "DELETE /api/orders/1001",
                "GET /api/admin/revenue",
                "POST /api/admin/users",            // ★ 3.3.4 漏掉的那一格，這次在表上
                "GET /api/reports/daily");
    }
}
```

```
═══ 3.3.7 五條規則的完整授權矩陣 ═══

═══ u4：順序正確、HTTP 方法有寫、anyRequest 兜底 ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/hello                      200      200      200      200      200
GET /api/orders/1001                401      200      200      200      200
POST /api/orders                    401      200      200      200      200
POST /api/orders/1001/refund        401      403      403      403      200
DELETE /api/orders/1001             401      403      403      403      204
GET /api/admin/revenue              401      403      403      403      200
POST /api/admin/users               401      403      403      403      200
GET /api/reports/daily              401      200      200      200      200
```

**這張矩陣有兩個地方值得停下來看**：

**① `cs`（客服）那一欄跟 alice / bob 一模一樣。**

客服**應該**能退款——`admin` 有 `order:refund`，`cs` 沒有。
這不是設定寫錯，是**權限模型還沒建起來**：現在權限是一列一列手寫進 `authority` 表的。
📌 **3.7 會把它改成「角色 → 權限」的資料表，然後客服那一欄就會自己亮起來。**

**② 最後一列：`GET /api/reports/daily` 對所有登入者開放。**

那支端點**沒有任何專屬規則**，掉進了 `anyRequest().authenticated()`。
今天它只是一張日報表，明天它可能是「全公司薪資報表」。
📌 **3.9.4 會寫一個掃描器，把所有「只靠 anyRequest 兜底」的端點列出來。**

⚠️ **還有一個這張矩陣【看不出來】的洞**：

```
GET /api/orders/1001   alice → 200      ✅ 是 alice 自己的訂單
GET /api/orders/1002   alice → ？        ← 這一格根本不在表上
```

**因為授權矩陣的維度是「端點 × 角色」，而 1002 是 bob 的訂單、bob 跟 alice 同角色。**
📌 **這就是 3.8 那一整節存在的理由。**

### 3.3.8 實測：`anyRequest()` 寫不寫，差在哪

3.2.4 那份規則表的最後一行寫著「沒有命中任何一條規則 → DENY」。**驗證它**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

public class U6Scenario {

    /** u6：🔴 沒有 anyRequest() —— 沒被任何規則命中的路徑會怎樣 */
    @Configuration
    @Profile("u6")
    static class U6_NoAnyRequest {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")
                    .requestMatchers("/api/orders/**").authenticated())
                    // ⚠️ 故意不寫 anyRequest()
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**表裡故意放了三支「沒有任何規則管到」的端點**——它們就是「下週有人新增的端點」：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "u6"})
class U6NoAnyRequestTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void noFallbackRule() {
        System.out.println("\n═══ 3.3.8 沒有寫 anyRequest()，新端點會怎樣 ═══");
        new Matrix(port).print("u6：只寫了 /api/admin/** 與 /api/orders/** 兩條規則",
                "GET /api/admin/revenue",           // 有規則
                "GET /api/orders/1001",             // 有規則
                "GET /api/reports/daily",           // ★ 沒有規則管到
                "GET /api/hello",                   // ★ 沒有規則管到
                "POST /api/echo");                  // ★ 沒有規則管到
    }
}
```

```
═══ 3.3.8 沒有寫 anyRequest()，新端點會怎樣 ═══

═══ u6：只寫了 /api/admin/** 與 /api/orders/** 兩條規則 ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/admin/revenue              401      403      403      403      200
GET /api/orders/1001                401      200      200      200      200
GET /api/reports/daily              401      403      403      403      403
GET /api/hello                      401      403      403      403      403
POST /api/echo                      401      403      403      403      403
```

✅ **沒被命中的路徑，全部被擋（fail-closed）。** 這是 Spring Security 的正確選擇。

⚠️ **但它跟 `.anyRequest().denyAll()` 有一個差別**：

```
沒寫 anyRequest()        規則表的最後【沒有東西】—— 3.2.4 那份輸出只有兩行規則
.anyRequest().denyAll()  規則表的最後有一行「any request → denyAll()」
```

**兩者行為一樣，但可讀性差很多。** 本課的建議：

```
🔴 不要靠「沒寫就是擋」這個預設行為 —— 讀你設定的人看不出你是「刻意」還是「忘了」
✅ 一律明確寫出最後一條：.anyRequest().authenticated() 或 .anyRequest().denyAll()
```

**對照三種寫法**（同一份設定，只改最後一行）：

| 最後一行 | 新增一支沒有規則的端點會怎樣 | 適合 |
|---|---|---|
| （不寫） | 403 / 401 | ❌ 不要用——看不出意圖 |
| `.anyRequest().authenticated()` | 登入的人可以打 | ✅ 對外服務的預設 |
| `.anyRequest().denyAll()` | 誰都不能打，**包含你自己** | ✅ 內部服務、金流服務 |
| `.anyRequest().permitAll()` | **誰都可以打** | 🔴 3.3.4 那個事故 |

📌 **`denyAll()` 兜底的代價**：每加一支端點都要記得加規則，
否則上線後回 403。**這個代價是划算的**——它把「忘記」變成一個**開發期就會發現**的問題。

### 3.3.9 URL 層規則的六條檢查清單

```
□ 最後一行是 anyRequest()，而且不是 permitAll()
□ 每一條規則都寫了 HTTP 方法（除非它真的對所有方法一致）
□ 前綴規則用 /**，不是只寫前綴本身
□ 越具體的規則越前面 —— 用 3.2.4 的規則表確認【真實順序】
□ /error 有明確的規則（permitAll），否則 400 / 500 會被蓋成 401
□ 沒有為了讓某個奇怪路徑能動而放寬 StrictHttpFirewall
```

---

## 3.4 `hasRole` 與 `hasAuthority`：`ROLE_` 那四個字

### 3.4.1 一段原始碼解釋整件事

**Spring Security 裡只有一種東西叫 `GrantedAuthority`，沒有「角色」這個型別。**

```java
public interface GrantedAuthority extends Serializable {
    String getAuthority();      // 就一個字串
}
```

**「角色」只是一個約定：開頭是 `ROLE_` 的 authority。**
而 `hasRole("ADMIN")` 做的事就是**幫你把那四個字加上去**：

```java
// org.springframework.security.authorization.AuthorityAuthorizationManager（6.2.4）
public static <T> AuthorityAuthorizationManager<T> hasRole(String role) {
    Assert.notNull(role, "role cannot be null");
    Assert.isTrue(!role.startsWith(ROLE_PREFIX), () -> role + " should not start with " + ROLE_PREFIX
            + " since " + ROLE_PREFIX + " is automatically prepended when using hasRole."
            + " Consider using hasAuthority instead.");
    return hasAuthority(ROLE_PREFIX + role);      // ★ 就這一行
}
```

**所以這兩行是同一件事**：

```java
.hasRole("ADMIN")               // → 找 "ROLE_ADMIN"
.hasAuthority("ROLE_ADMIN")     // → 找 "ROLE_ADMIN"
```

**而這兩行不是**：

```java
.hasRole("ADMIN")               // → 找 "ROLE_ADMIN"
.hasAuthority("ADMIN")          // → 找 "ADMIN"       ← 資料庫裡沒有這個字串
```

📌 **一句話**：`hasRole(X)` 就是 `hasAuthority("ROLE_" + X)`。**沒有別的魔法。**

### 3.4.2 實測：七條規則的對照

**八支端點走同一個 handler，差別完全在安全設定**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.authorization.AuthorityAuthorizationManager;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

public class RoleScenarios {

    /** r1：七條規則，每一條掛一支端點，看誰進得去 */
    @Configuration
    @Profile("r1")
    static class R1_Prefix {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/r/hasRole-ADMIN").hasRole("ADMIN")
                    .requestMatchers("/api/r/hasAuthority-ADMIN").hasAuthority("ADMIN")
                    .requestMatchers("/api/r/hasAuthority-ROLE_ADMIN").hasAuthority("ROLE_ADMIN")
                    .requestMatchers("/api/r/hasAuthority-refund").hasAuthority("order:refund")
                    .requestMatchers("/api/r/hasRole-refund").hasRole("order:refund")
                    .requestMatchers("/api/r/hasAnyRole").hasAnyRole("ADMIN", "CS_AGENT")
                    .requestMatchers("/api/r/manager").access(
                            AuthorityAuthorizationManager.hasAnyAuthority("ROLE_ADMIN", "order:refund"))
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** r2：把前綴從 ROLE_ 換成 PERM_ —— 一個 bean 影響全域 */
    @Configuration
    @Profile("r2")
    static class R2_CustomPrefix {
        @Bean
        static org.springframework.security.config.core.GrantedAuthorityDefaults
        grantedAuthorityDefaults() {
            return new org.springframework.security.config.core.GrantedAuthorityDefaults("PERM_");
        }                                                     // ⚠️ 一定要 static，理由見 3.4.4

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/r/hasRole-ADMIN").hasRole("ADMIN")
                    .requestMatchers("/api/r/hasAuthority-ROLE_ADMIN").hasAuthority("ROLE_ADMIN")
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** r3：🔴 hasRole("ROLE_ADMIN") —— URL 層【啟動就會失敗】 */
    @Configuration
    @Profile("r3")
    static class R3_DoublePrefix {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/api/r/hasRole-ROLE_ADMIN").hasRole("ROLE_ADMIN")
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**七條規則各打一次，並且先把每個帳號手上的 authority 印出來當對照**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "r1"})
class RulePrefixTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void prefixMatrix() {
        System.out.println("""
                
                ═══ 3.4.2 七條規則，同一支端點 ═══
                帳號帶的 authority：
                  alice / bob  →  [ROLE_USER]
                  cs           →  [ROLE_CS_AGENT]
                  admin        →  [ROLE_ADMIN, ROLE_USER, order:refund]""");
        new Matrix(port).print("r1：200 = 通過、403 = 被擋",
                "GET /api/r/hasRole-ADMIN",
                "GET /api/r/hasAuthority-ADMIN",
                "GET /api/r/hasAuthority-ROLE_ADMIN",
                "GET /api/r/hasRole-ROLE_ADMIN",
                "GET /api/r/hasAuthority-refund",
                "GET /api/r/hasRole-refund",
                "GET /api/r/hasAnyRole",
                "GET /api/r/manager");
    }
}
```

```
═══ 3.4.2 七條規則，同一支端點 ═══
帳號帶的 authority：
  alice / bob  →  [ROLE_USER]
  cs           →  [ROLE_CS_AGENT]
  admin        →  [ROLE_ADMIN, ROLE_USER, order:refund]

═══ r1：200 = 通過、403 = 被擋 ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/r/hasRole-ADMIN            401      403      403      403      200
GET /api/r/hasAuthority-ADMIN       401      403      403      403      403
GET /api/r/hasAuthority-ROLE_ADMIN  401      403      403      403      200
GET /api/r/hasRole-ROLE_ADMIN       401      200      200      200      200
GET /api/r/hasAuthority-refund      401      403      403      403      200
GET /api/r/hasRole-refund           401      403      403      403      403
GET /api/r/hasAnyRole               401      403      403      200      200
GET /api/r/manager                  401      403      403      403      200
```

**逐列判讀**：

| 規則 | admin 的結果 | 為什麼 |
|---|---|---|
| `hasRole("ADMIN")` | ✅ 200 | 找 `ROLE_ADMIN`，有 |
| `hasAuthority("ADMIN")` | ❌ 403 | 找 `ADMIN`，**資料庫裡沒有這個字串** |
| `hasAuthority("ROLE_ADMIN")` | ✅ 200 | 找 `ROLE_ADMIN`，有——**跟第一列完全等價** |
| **（這一條寫不出來）** | ⚠️ 200，**而且每個人都 200** | 見下 |
| `hasAuthority("order:refund")` | ✅ 200 | 找 `order:refund`，有 |
| `hasRole("order:refund")` | ❌ 403 | 找 **`ROLE_order:refund`**——沒有這個東西 |
| `hasAnyRole("ADMIN","CS_AGENT")` | ✅ 200（cs 也 200） | 找 `ROLE_ADMIN` 或 `ROLE_CS_AGENT` |
| `hasAnyAuthority("ROLE_ADMIN","order:refund")` | ✅ 200 | 兩個字串**原樣**比對 |

⚠️ **第四列（`/api/r/hasRole-ROLE_ADMIN`）那一整排 200 不是規則放行，是【沒有規則】。**

```java
// 這一行【寫不出來】—— 寫下去整個服務啟動就失敗（3.4.3 會證明）
.requestMatchers("/api/r/hasRole-ROLE_ADMIN").hasRole("ROLE_ADMIN")
```

所以 `R1_Prefix` 裡只有七條規則，而端點有八支。
第八支沒有任何規則管到，**掉進最後的 `anyRequest().authenticated()`**——
只要登入就通過，所以 alice / bob / cs / admin 全部 200。

📌 **這一列順便示範了 3.3.8 那件事**：
「表上多出一支你沒寫規則的端點」長什麼樣子——**它不會報錯，它會放行。**

⚠️ **第六列是最容易寫錯的一個**：

```java
.requestMatchers("/api/orders/*/refund").hasRole("order:refund")     // 🔴 永遠 403
.requestMatchers("/api/orders/*/refund").hasAuthority("order:refund") // ✅
```

**「權限」（`order:refund`）永遠用 `hasAuthority`，「角色」（`ADMIN`）永遠用 `hasRole`。**
混用不會報錯，只會**永遠不通過**——而「永遠不通過」在測試裡看起來很像「規則生效了」。

### 3.4.3 🔴 兩層對同一句話的反應【不一樣】

**這是本章最違反直覺的一個發現。**

**URL 層**寫 `hasRole("ROLE_ADMIN")`：

```java
package com.example.lab09.ch03;

import com.example.lab09.LabApp;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

class R3StartupTest {

    @Test
    void hasRoleWithPrefixFailsAtStartup() {
        System.out.println("\n═══ 3.4.3 URL 層寫 hasRole(\"ROLE_ADMIN\") ═══");
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(LabApp.class)
                .web(WebApplicationType.SERVLET)
                .profiles("db", "ch3", "r3")
                .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF")
                .run()) {
            System.out.println("🔴 竟然啟動成功了？");
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            System.out.println("✅ 啟動失敗：" + root.getClass().getSimpleName());
            System.out.println("   " + root.getMessage());
        }
    }
}
```

```
═══ 3.4.3 URL 層寫 hasRole("ROLE_ADMIN") ═══
✅ 啟動失敗：IllegalArgumentException
   ROLE_ADMIN should not start with ROLE_ since ROLE_ is automatically prepended
   when using hasAnyRole. Consider using hasAnyAuthority instead.
```

**方法層**寫**同一句話**（`@PreAuthorize("hasRole('ROLE_ADMIN')")`）：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.List;

/** 3.4.3：URL 層寫這句話會啟動失敗（上面那個測試），方法層寫同一句話呢？ */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m1"})
class DoublePrefixTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static void show(String who, HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ");
        if (b.length() > 130) b = b.substring(0, 130) + "…";
        System.out.printf("   %-8s → %d  %s%n", who, r.statusCode(), b);
    }

    @Test
    void doublePrefix() {
        System.out.println("\n═══ 3.4.3 方法層寫 hasRole('ROLE_ADMIN') ═══");
        System.out.println("   （URL 層寫同一句話會【啟動失敗】）");
        Matrix m = new Matrix(port);
        // /api/m/double-prefix 背後是 @PreAuthorize("hasRole('ROLE_ADMIN')")
        for (String u : List.of("alice", "cs", "admin"))
            show(u, m.send("GET", "/api/m/double-prefix", u));
    }
}
```

```
═══ 3.4.3 方法層寫 hasRole('ROLE_ADMIN') ═══
   （URL 層寫同一句話會【啟動失敗】）
   alice    → 403  {"status":403,"error":"Forbidden","path":"/api/m/double-prefix"}
   cs       → 403  {"status":403,"error":"Forbidden","path":"/api/m/double-prefix"}
   admin    → 200  進來了
```

**方法層完全正常。** 為什麼？兩邊的實作不一樣：

```java
// ① URL 層：AuthorityAuthorizationManager.toNamedRolesArray —— 直接【拒絕】帶前綴的參數
Assert.isTrue(rolePrefix.isEmpty() || !role.startsWith(rolePrefix), () -> role
        + " should not start with " + rolePrefix + " since " + rolePrefix
        + " is automatically prepended when using hasAnyRole. Consider using hasAnyAuthority instead.");
result[i] = rolePrefix + role;

// ② 方法層 SpEL：SecurityExpressionRoot.getRoleWithDefaultPrefix —— 【容忍】帶前綴的參數
private static String getRoleWithDefaultPrefix(String defaultRolePrefix, String role) {
    if (role == null) return role;
    if (defaultRolePrefix == null || defaultRolePrefix.length() == 0) return role;
    if (role.startsWith(defaultRolePrefix)) return role;      // ★ 已經有前綴就不再加
    return defaultRolePrefix + role;
}
```

📌 **一張對照表**：

| 你寫的 | URL 層 | 方法層 SpEL |
|---|---|---|
| `hasRole("ADMIN")` | ✅ 找 `ROLE_ADMIN` | ✅ 找 `ROLE_ADMIN` |
| `hasRole("ROLE_ADMIN")` | 🔴 **啟動失敗** | ✅ 找 `ROLE_ADMIN`（自動偵測，不重複加） |
| `hasAuthority("ADMIN")` | 找 `ADMIN` | 找 `ADMIN` |

⚠️ **不要因為「方法層容忍」就寫 `hasRole('ROLE_ADMIN')`**：

```
① 你的規則在兩層之間【搬不動】—— 從 @PreAuthorize 搬到 requestMatchers 會啟動失敗
② 團隊裡兩種寫法混用，review 的人要記住「哪一層可以哪一層不行」
③ 如果哪天你換掉前綴（3.4.4），寫死 ROLE_ 的那些會全部失效
```

📌 **本課的規則：`hasRole` 的參數【永遠不帶前綴】，兩層一致。**

### 3.4.4 實測：`GrantedAuthorityDefaults`

**`ROLE_` 這四個字可以換掉，而且只要一個 bean**：

```java
@Bean
static GrantedAuthorityDefaults grantedAuthorityDefaults() {
    return new GrantedAuthorityDefaults("PERM_");
}
```

**只打兩支端點就夠了**（設定是 3.4.2 那個 `RoleScenarios.R2_CustomPrefix`）：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "r2"})
class PrefixOverrideTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void customPrefix() {
        System.out.println("\n═══ 3.4.4 GrantedAuthorityDefaults(\"PERM_\") ═══");
        new Matrix(port).print("r2：資料庫裡存的還是 ROLE_ADMIN，前綴卻被改成 PERM_",
                "GET /api/r/hasRole-ADMIN",              // hasRole 現在找 PERM_ADMIN
                "GET /api/r/hasAuthority-ROLE_ADMIN");   // hasAuthority 不加前綴，不受影響
    }
}
```

```
═══ 3.4.4 GrantedAuthorityDefaults("PERM_") ═══

═══ r2：資料庫裡存的還是 ROLE_ADMIN，前綴卻被改成 PERM_ ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/r/hasRole-ADMIN            401      403      403      403      403
GET /api/r/hasAuthority-ROLE_ADMIN  401      403      403      403      200
```

**第一列：admin 被自己的規則擋在外面。**
`hasRole("ADMIN")` 現在找的是 `PERM_ADMIN`，而資料庫裡是 `ROLE_ADMIN`。

⚠️ **三件事要知道**：

```
① 這個 bean 是【全域】的 —— URL 層、方法層、Thymeleaf 標籤全部一起改
② 🔴 一定要宣告成 static
     它要在 BeanPostProcessor 階段就被讀到，非 static 的話會太晚建立而不生效
③ hasAuthority("ROLE_ADMIN") 不受影響 —— 它不加任何前綴
```

📌 **什麼時候真的需要換前綴？** 幾乎沒有。
唯一常見的情境是**接手一個既有系統**，它的 authority 表裡存的是 `PERM_` 或什麼都不加。
**新專案請沿用 `ROLE_`**——所有 Spring 生態的文件、範例、第三方套件都假設它。

### 3.4.5 角色 vs 權限：什麼時候用哪一個

| | 角色 Role | 權限 Permission / Authority |
|---|---|---|
| 例子 | `ADMIN`、`CS_AGENT`、`MEMBER` | `order:read`、`order:refund`、`user:manage` |
| 語意 | **這個人是誰**（身分、職務） | **可以做什麼**（動作） |
| 數量 | 少（通常 3～10 個） | 多（幾十到幾百個） |
| 變動頻率 | 低 | **高**——每加一個功能就可能多一個 |
| 存哪裡 | `app_role` | `permission` |
| 寫在規則裡 | `hasRole("ADMIN")` | `hasAuthority("order:refund")` |
| 誰決定 | 產品／組織 | 開發者 |

🔴 **本課的核心建議**：

> **規則裡寫【權限】，不要寫角色。**
> 角色只是「一組權限的名字」——它應該只出現在**資料表**裡，不應該出現在**程式碼**裡。

```java
// 🔴 半年後會炸
.requestMatchers(POST, "/api/orders/*/refund").hasRole("ADMIN")

// ✅
.requestMatchers(POST, "/api/orders/*/refund").hasAuthority("order:refund")
```

**差別在哪？** 3.7.2 會用一個具體的情境算給你看：
「客服也要能退款」這個需求，第一種寫法要改**程式碼並重新部署**，
第二種寫法只要在資料庫裡**加一列**。

⚠️ **唯一該用 `hasRole` 的地方**：真的在描述「身分」，而不是「動作」。

```java
.requestMatchers("/admin/**").hasRole("ADMIN")     // ✅ 「後台整個區域只給管理員」是身分判斷
```

---

## 3.5 方法層授權

### 3.5.1 為什麼需要第二層

URL 層已經可以擋掉很多東西了。**為什麼還要第二層？** 四個理由：

```
① URL 層看不到方法參數
     POST /api/transfer  { "fromAccount": "...", "amount": 1000000 }
     「金額超過十萬要主管核准」—— 這條規則在 URL 層寫不出來

② URL 層看不到回傳值
     「只有本人和管理員看得到這筆訂單」—— 要先查出來才知道是誰的（3.8）

③ 同一個 Service 方法可能有【多個入口】
     REST API、排程任務、訊息佇列消費者、GraphQL …
     規則寫在 URL 層，換一個入口就整個不見了

④ URL 層的規則跟程式碼【離很遠】
     改 OrderService.refund() 的人，不會想到要去翻 SecurityConfig
```

📌 **第 ③ 點是最實際的一個。** 回到 3.2.1 那個判準：

> **把 Controller 整支刪掉、換一個新的 Controller 呼叫同一個 Service，哪些檢查會跟著不見？**

URL 層的規則**全部**會不見。方法層的不會。

### 3.5.2 實測：四種註解，與忘了打開開關

**先打開它。** 一個註解：

```java
@Configuration
@EnableMethodSecurity        // ★ 預設只開 @PreAuthorize / @PostAuthorize / @PreFilter / @PostFilter
class SecurityConfig { }
```

**四種註解**：

| 註解 | 來自 | 預設開關 | 能寫 SpEL | 能拿到參數 / 回傳值 |
|---|---|---|---|---|
| `@PreAuthorize` / `@PostAuthorize` | Spring Security | ✅ 開 | ✅ | ✅ |
| `@PreFilter` / `@PostFilter` | Spring Security | ✅ 開 | ✅ | ✅ |
| `@Secured` | Spring Security（舊） | ❌ `securedEnabled = true` | ❌ 只能列 authority 字串 | ❌ |
| `@RolesAllowed` / `@PermitAll` / `@DenyAll` | JSR-250（`jakarta.annotation.security`） | ❌ `jsr250Enabled = true` | ❌ | ❌ |

```java
package com.example.lab09.ch03;

import jakarta.annotation.security.*;
import org.springframework.security.access.annotation.Secured;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Service;

/** 3.5.2：四種註解的對照。 */
@Service
public class LegacyService3 implements ReportApi {

    @Secured("ROLE_ADMIN")          // ⚠️ @Secured 【不會】自動加前綴，要自己寫全
    public String securedWithPrefix() { return "進來了"; }

    @Secured("ADMIN")               // 🔴 找的是字串 "ADMIN"
    public String securedNoPrefix() { return "進來了"; }

    @RolesAllowed("ADMIN")          // ✅ JSR-250 【會】自動加 ROLE_ 前綴
    public String rolesAllowed() { return "進來了"; }

    @PermitAll
    public String permitAll() { return "進來了"; }

    @DenyAll
    public String denyAll() { return "進來了"; }

    /** 這個方法【自己】沒有註解，註解在 ReportApi 介面上（3.5.9） */
    @Override
    public String daily() { return "介面上的 @PreAuthorize 生效了"; }

    /** 介面上沒有註解，實作也沒有 */
    @Override
    public String monthly() { return "monthly 沒有任何註解"; }

    // ───────── 下面兩個是 3.6 要用的，先放在這裡 ─────────

    @RequireOrderOwner                                    // ★ 3.6.3 的自訂註解
    public Ord3 byMetaAnnotation(Long id, Ord3Repo repo) { return repo.findById(id).orElse(null); }

    @PreAuthorize("@orderGuard.canRead(#id, authentication)")   // ★ 3.6.2
    public Ord3 byBeanExpression(Long id, Ord3Repo repo) { return repo.findById(id).orElse(null); }
}
```

⚠️ `LegacyService3` 用到 `@PreAuthorize`，所以 import 要多一行
`org.springframework.security.access.prepost.PreAuthorize`。

```java
package com.example.lab09.ch03;

import org.springframework.security.access.prepost.PreAuthorize;

/** 3.5.9：註解寫在【介面】上 */
public interface ReportApi {

    @PreAuthorize("hasRole('ADMIN')")
    String daily();

    String monthly();
}
```

**設定**（兩個開關都打開）：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

public class M3Config {

    @Configuration
    @EnableMethodSecurity(securedEnabled = true, jsr250Enabled = true)   // ★ 這兩個預設是 false
    @Profile("m3 | m4 | m5 | m6")
    static class Config {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")     // ← 3.5.8 要拿它當對照組
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**五支端點，每一支掛一種註解**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m3"})
class AnnotationFlavourTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void fourFlavours() {
        System.out.println("\n═══ 3.5.2 四種方法層註解 ═══");
        new Matrix(port).print("m3：@EnableMethodSecurity(securedEnabled = true, jsr250Enabled = true)",
                "GET /api/l/secured-prefix",      // @Secured("ROLE_ADMIN")
                "GET /api/l/secured-noprefix",    // @Secured("ADMIN")      ★ 不會自動加前綴
                "GET /api/l/roles-allowed",       // @RolesAllowed("ADMIN")
                "GET /api/l/permit-all",          // @PermitAll
                "GET /api/l/deny-all");           // @DenyAll
    }
}
```

```
═══ 3.5.2 四種方法層註解 ═══

═══ m3：@EnableMethodSecurity(securedEnabled = true, jsr250Enabled = true) ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/l/secured-prefix           401      403      403      403      200
GET /api/l/secured-noprefix         401      403      403      403      403
GET /api/l/roles-allowed            401      403      403      403      200
GET /api/l/permit-all               401      200      200      200      200
GET /api/l/deny-all                 401      403      403      403      403
```

**第二列 vs 第三列**：

```
@Secured("ADMIN")       → 403（連 admin 都進不去）—— 它【不】加前綴
@RolesAllowed("ADMIN")  → 200                     —— 它【會】加前綴
```

⚠️ **兩個看起來一樣的註解，前綴行為相反。** 這就是為什麼本課只推薦一組：

```
✅ 新程式碼一律用 @PreAuthorize / @PostAuthorize
   - 它是四種裡唯一能寫 SpEL 的（拿得到參數、回傳值、可以呼叫 bean）
   - 前綴行為跟 URL 層的 hasRole 一致（3.4.3）
   - 兩個 securedEnabled / jsr250Enabled 開關不用開

⚠️ @Secured / @RolesAllowed 只在【接手舊專案】時會遇到
```

**現在把 `@EnableMethodSecurity` 拿掉，其他一個字都不改**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** m2 的設定跟 m1 逐字相同，唯一的差別是類別上少了 @EnableMethodSecurity。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m2"})
class MethodNotEnabledTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void forgotEnableMethodSecurity() {
        System.out.println("\n═══ 3.5.2 🔴 忘了寫 @EnableMethodSecurity ═══");
        new Matrix(port).print("m2：程式碼跟 m1 一模一樣，只差沒有那一行註解",
                "GET /api/m/all",                 // @PreAuthorize("hasRole('ADMIN')")
                "POST /api/m/refund/1001",        // @PreAuthorize("hasAuthority('order:refund')")
                "GET /api/m/one/1002",            // @PostAuthorize(...)
                "GET /api/m/filtered");           // @PostFilter(...)
    }
}
```

```
═══ 3.5.2 🔴 忘了寫 @EnableMethodSecurity ═══

═══ m2：程式碼跟 m1 一模一樣，只差沒有那一行註解 ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/m/all                      401      200      200      200      200
POST /api/m/refund/1001             401      200      200      200      200
      [方法內] findOne(1002) 真的執行了，而且查了資料庫
      [方法內] findOne(1002) 真的執行了，而且查了資料庫
      [方法內] findOne(1002) 真的執行了，而且查了資料庫
      [方法內] findOne(1002) 真的執行了，而且查了資料庫
GET /api/m/one/1002                 401      200      200      200      200
      [方法內] 從資料庫撈回 3 筆
      [方法內] 從資料庫撈回 3 筆
      [方法內] 從資料庫撈回 3 筆
      [方法內] 從資料庫撈回 3 筆
GET /api/m/filtered                 401      200      200      200      200
```

🔴 **全部 200。所有 `@PreAuthorize` 變成純粹的註解文字。**

📌 **中間那些 `[方法內]` 是 Service 自己印的**，它們是最直接的證據：
`findOne(1002)` 對四個帳號**各執行了一次**，`@PostAuthorize` 連看都沒看。
（一列四個 `[方法內]`，是因為矩陣的那一列要打 alice / bob / cs / admin 四次。）

```
啟動不報錯
沒有 WARN
IDE 不會提示
註解還好端端地寫在那裡
```

📌 **這是「方法層授權沒生效」的第一個原因**（另外兩個在 3.5.5）。
**開發環境一定要有一個測試，證明某個 `@PreAuthorize` 真的會擋人**——
不然這一行不見了你不會知道。08 章會把這個做成上線前檢查清單的一項。

### 3.5.3 實測：URL 層放行，方法層接手

**這一節開始，URL 層只剩一條規則**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

/** 3.5 方法層授權的設定。 */
public class MethodSecurityScenarios {

    /** m1：只在 URL 層要求「登入」，其他全部交給方法層 */
    @Configuration
    @EnableMethodSecurity                       // ★ 這一行就是開關
    @Profile("m1")
    static class M1_MethodOnly {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()
                    .anyRequest().authenticated())          // ← URL 層【只】檢查有沒有登入
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** m2：忘了寫 @EnableMethodSecurity —— 所有註解變成註解 */
    @Configuration
    @Profile("m2")
    static class M2_NotEnabled {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**服務**（3.5 全節都用這一個，後面幾節會回頭看它的每一個方法）：

```java
package com.example.lab09.ch03;

import org.springframework.security.access.prepost.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;

/** 3.5 方法層授權的實驗對象。每一個方法示範一種寫法（含刻意寫壞的）。 */
@Service
public class OrderService3 {

    private final Ord3Repo repo;
    public OrderService3(Ord3Repo repo) { this.repo = repo; }

    // ───────── ① @PreAuthorize 的基本款 ─────────

    @PreAuthorize("hasRole('ADMIN')")
    public List<Ord3> allOrders() { return repo.findAll(); }

    /** 🔴 3.4.3：方法層的 hasRole('ROLE_ADMIN') —— 跟 URL 層不同，它【不會】報錯 */
    @PreAuthorize("hasRole('ROLE_ADMIN')")
    public String doublePrefix() { return "進來了"; }

    /** 3.4.3 對照組 */
    @PreAuthorize("hasAuthority('ADMIN')")
    public String authorityNoPrefix() { return "進來了"; }

    @PreAuthorize("hasAuthority('ROLE_ADMIN')")
    public String authorityWithPrefix() { return "進來了"; }

    @PreAuthorize("hasAuthority('order:refund')")
    public String refund(Long id) { return "退款 " + id; }

    /** #owner 是方法參數；authentication 是內建變數（3.5.4） */
    @PreAuthorize("#owner == authentication.name or hasRole('ADMIN')")
    public List<Ord3> byOwner(String owner) { return repo.findByOwnerUsername(owner); }

    // ───────── ② @PostAuthorize：先執行、再檢查 ─────────

    @PostAuthorize("returnObject == null or returnObject.ownerUsername == authentication.name or hasRole('ADMIN')")
    public Ord3 findOne(Long id) {
        System.out.println("      [方法內] findOne(" + id + ") 真的執行了，而且查了資料庫");
        return repo.findById(id).orElse(null);
    }

    /** 🔴 3.5.6：@PostAuthorize + @Transactional 的順序問題 */
    @Transactional
    @PostAuthorize("hasRole('ADMIN')")
    public Ord3 markShipped(Long id) {
        Ord3 o = repo.findById(id).orElseThrow();
        o.setStatus("SHIPPED");
        System.out.println("      [方法內] 已經把 " + id + " 改成 SHIPPED（交易還沒結束）");
        return o;
    }

    // ───────── ③ @PreFilter / @PostFilter ─────────

    @PostFilter("filterObject.ownerUsername == authentication.name")
    public List<Ord3> allThenFilter() {
        List<Ord3> all = repo.findAll();
        System.out.println("      [方法內] 從資料庫撈回 " + all.size() + " 筆");
        return all;
    }

    @PreFilter("filterObject.ownerUsername == authentication.name")
    public int bulkCancel(List<Ord3> orders) {
        System.out.println("      [方法內] 收到 " + orders.size() + " 筆要取消");
        return orders.size();
    }

    // ───────── ④ 自我呼叫（3.5.5）─────────

    /** 🔴 同一個類別裡直接呼叫，代理不在中間，註解形同不存在 */
    public String outerCallsInner() { return innerAdminOnly(); }

    @PreAuthorize("hasRole('ADMIN')")
    public String innerAdminOnly() { return "innerAdminOnly() 的回傳值"; }

    /** 🔴 private 方法上的註解：Spring 連掃都不會掃到 */
    public String outerCallsPrivate() { return privateAdminOnly(); }

    @PreAuthorize("hasRole('ADMIN')")
    private String privateAdminOnly() { return "privateAdminOnly() 的回傳值"; }

    /** 不帶任何註解的查詢，給 3.5.7 的 @PreFilter 準備輸入用 */
    public Ord3 findOneRaw(Long id) { return repo.findById(id).orElseThrow(); }

    /** ✅ 正確的自我呼叫寫法：走一次代理（02 站 04 章 AOP 的三種修法之一） */
    public String outerViaSelf(OrderService3 self) { return self.innerAdminOnly(); }
}
```

**實測**：

**同一條 URL 規則管住全部四支端點**，所以下面每一列的差別**只可能**來自方法上的註解：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m1"})
class MethodSecurityTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void urlLayerLetsEverythingThrough() {
        System.out.println("\n═══ 3.5.3 URL 層只寫 anyRequest().authenticated()，方法層接手 ═══");
        new Matrix(port).print("m1：URL 規則只有一條，下面每一列的差別【全部】來自方法上的註解",
                "GET /api/m/all",
                "POST /api/m/refund/1001",
                "GET /api/m/by-owner?owner=alice",
                "GET /api/m/by-owner?owner=bob");
    }
}
```

```
═══ 3.5.3 URL 層只寫 anyRequest().authenticated()，方法層接手 ═══

═══ m1：URL 規則只有一條，下面每一列的差別【全部】來自方法上的註解 ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/m/all                      401      403      403      403      200
POST /api/m/refund/1001             401      403      403      403      200
GET /api/m/by-owner?owner=alice     401      200      403      403      200
GET /api/m/by-owner?owner=bob       401      403      200      403      200
```

**第三列與第四列是 URL 層做不到的事**：

```java
@PreAuthorize("#owner == authentication.name or hasRole('ADMIN')")
public List<Ord3> byOwner(String owner) { ... }
```

```
alice 查 owner=alice  → 200
alice 查 owner=bob    → 403       ← URL 層看不到 query string 的內容
```

📌 **注意這一條規則的形狀**：`#owner == authentication.name`。
它做的是「**參數必須等於我自己**」——這是**資源層授權在方法層的一種特例**，
成立的條件是「擁有者的識別碼**就在參數裡**」。3.8 會處理識別碼不在參數裡的情況。

### 3.5.4 SpEL 裡拿得到什麼

```java
@PreAuthorize("...")     // 這個字串是 Spring Expression Language
```

**內建變數與函式**：

| 寫法 | 是什麼 | 只能用在 |
|---|---|---|
| `authentication` | 整個 `Authentication` 物件 | 都可以 |
| `principal` | `authentication.getPrincipal()`（通常是 `UserDetails`） | 都可以 |
| `hasRole('X')` / `hasAnyRole(...)` | 找 `ROLE_X` | 都可以 |
| `hasAuthority('x')` / `hasAnyAuthority(...)` | 原樣比對 | 都可以 |
| `permitAll` / `denyAll` / `isAuthenticated()` / `isAnonymous()` / `isFullyAuthenticated()` | 同 3.3.6 | 都可以 |
| `#參數名` | 方法參數 | `@PreAuthorize` / `@PostAuthorize` |
| `returnObject` | **回傳值** | 只有 `@PostAuthorize` |
| `filterObject` | 集合裡的**每一個元素** | 只有 `@PreFilter` / `@PostFilter` |
| `@beanName.method(...)` | 呼叫容器裡的 bean（3.6.2） | 都可以 |

**幾個實用的例子**：

```java
// 拿 principal 上的自訂欄位（02 章 2.7.2 那個 AppUserDetails 多帶了 displayName）
@PreAuthorize("principal.displayName == '管理員'")

// 參數是物件時可以往下鑽
@PreAuthorize("#order.ownerUsername == authentication.name")
public void save(Ord3 order) { }

// 兩個條件組合
@PreAuthorize("hasAuthority('order:refund') and #amount <= 100000")
public void refund(Long id, long amount) { }

// 呼叫自己寫的 bean（3.6.2 —— 本課最推薦的寫法）
@PreAuthorize("@orderGuard.canRead(#id, authentication)")
public Ord3 read(Long id) { }
```

⚠️ **`#參數名` 需要參數名在 class 檔裡留得下來。**
Spring Boot 的 Maven / Gradle plugin 預設已經加上 `-parameters`，所以一般沒問題。
**如果你的 build 不是從 Boot 的 parent POM 來的**，`#owner` 會變成 `null`，
而 `null == authentication.name` 是 `false`——**規則會變成「永遠拒絕」**。
📌 **這個失敗方向是安全的**（fail-closed），但你會看到一堆莫名其妙的 403。

⚠️ **SpEL 是字串，編譯器不會檢查它。**

```java
@PreAuthorize("hasRole('ADMIM')")        // 打錯字 → 永遠 403，不會有任何警告
@PreAuthorize("#ownr == authentication.name")   // 參數名打錯 → 永遠 403
```

📌 **這是 3.6 存在的理由**：把規則搬進 Java 方法，讓編譯器與 IDE 幫你看。

### 3.5.5 🔴 實測：自我呼叫與 `private` 方法

**方法層授權是 AOP，而 AOP 靠的是代理。**

```
外面呼叫  ──▸ [代理] ──▸ 真正的物件.method()
                ↑
           註解在這裡被檢查

物件【自己】呼叫自己 ──▸ 真正的物件.method()
                          ↑
                     代理不在路徑上，什麼都不會發生
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m1"})
class SelfInvocationTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static void show(String who, HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ");
        if (b.length() > 130) b = b.substring(0, 130) + "…";
        System.out.printf("   %-8s → %d  %s%n", who, r.statusCode(), b);
    }

    @Test
    void selfInvocation() {
        System.out.println("\n═══ 3.5.5 自我呼叫與 private 方法 ═══");
        Matrix m = new Matrix(port);
        for (String[] c : new String[][]{
                {"/api/m/outer",         "outerCallsInner() → this.innerAdminOnly()"},
                {"/api/m/outer-private", "outerCallsPrivate() → this.privateAdminOnly()"},
                {"/api/m/outer-self",    "outerViaSelf(self) → self.innerAdminOnly()"}}) {
            System.out.println("\n   " + c[1]);
            for (String u : java.util.List.of("alice", "admin")) show(u, m.send("GET", c[0], u));
        }
    }
}
```

```
═══ 3.5.5 自我呼叫與 private 方法 ═══

   outerCallsInner() → this.innerAdminOnly()
   alice    → 200  innerAdminOnly() 的回傳值
   admin    → 200  innerAdminOnly() 的回傳值

   outerCallsPrivate() → this.privateAdminOnly()
   alice    → 200  privateAdminOnly() 的回傳值
   admin    → 200  privateAdminOnly() 的回傳值

   outerViaSelf(self) → self.innerAdminOnly()
   alice    → 403  {"status":403,"error":"Forbidden","path":"/api/m/outer-self"}
   admin    → 200  innerAdminOnly() 的回傳值
```

🔴 **前兩組：alice 通過了。`@PreAuthorize("hasRole('ADMIN')")` 就寫在那個方法上。**

**這是「方法層授權沒生效」的另外兩個原因**：

```
② 自我呼叫（this.method()）      —— 代理不在路徑上
③ 註解標在 private 方法上         —— CGLIB 代理只能攔 public / protected 方法，
                                    Spring 連掃描都不會掃到它
```

⚠️ **三個原因裡，只有第 ① 個（忘了 @EnableMethodSecurity）會【整個服務】一起失效。**
②③ 是**一個方法一個方法**地悄悄失效——你完全看不出來。

**修法**（跟 02 站 04 章 AOP 那三種一樣）：

```java
// 修法 A：注入自己（最直接；@Lazy 是為了避開循環相依）
@Autowired @Lazy OrderService3 self;
public String outer() { return self.innerAdminOnly(); }

// 修法 B：AopContext（要 @EnableAspectJAutoProxy(exposeProxy = true)）
public String outer() { return ((OrderService3) AopContext.currentProxy()).innerAdminOnly(); }

// 修法 C ✅ 本課推薦：把它拆成兩個 bean
//   「需要授權的那件事」本來就是另一個責任 —— 拆開之後代理自然在路徑上
```

📌 **最實際的一條紀律**：

> **方法層授權的註解，只標在【會被別人呼叫】的方法上——
> 也就是那個 bean 的「對外介面」。**
> 內部 helper 不要標——標了也不會生效，而且會給人一種「這裡有保護」的錯覺。

**怎麼發現既有專案裡有沒有這個問題？** 一條 grep 就抓得到大部分：

```bash
# 找出所有標了註解的 private 方法
grep -rn -B2 "private .*(" --include="*.java" src/main \
  | grep -E "@(PreAuthorize|PostAuthorize|Secured|RolesAllowed)"
```

自我呼叫抓不到，但**3.9 那張授權矩陣抓得到**——只要那個端點在表上。

---

### 3.5.6 🔴 實測：`@PostAuthorize` 與交易的順序

**`@PostAuthorize` 的定義就寫在名字裡：方法【跑完之後】才檢查。**

```java
@PostAuthorize("returnObject == null or returnObject.ownerUsername == authentication.name or hasRole('ADMIN')")
public Ord3 findOne(Long id) {
    System.out.println("      [方法內] findOne(" + id + ") 真的執行了，而且查了資料庫");
    return repo.findById(id).orElse(null);
}
```

**注意輸出裡那一行 `[方法內]`**——它證明方法在被擋下來之前**已經整個跑完了**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m1"})
class PostAuthorizeReadTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static void show(String who, HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ");
        if (b.length() > 130) b = b.substring(0, 130) + "…";
        System.out.printf("   %-8s → %d  %s%n", who, r.statusCode(), b);
    }

    @Test
    void postAuthorize() {
        System.out.println("\n═══ 3.5.6 @PostAuthorize：方法【已經跑完】才檢查 ═══");
        Matrix m = new Matrix(port);
        System.out.println("\n   alice 讀自己的訂單 1001：");
        show("alice", m.send("GET", "/api/m/one/1001", "alice"));
        System.out.println("\n   alice 讀 bob 的訂單 1002：");
        show("alice", m.send("GET", "/api/m/one/1002", "alice"));
    }
}
```

```
═══ 3.5.6 @PostAuthorize：方法【已經跑完】才檢查 ═══

   alice 讀自己的訂單 1001：
      [方法內] findOne(1001) 真的執行了，而且查了資料庫
   alice    → 200  {"id":1001,"ownerUsername":"alice","amount":1280.00,"status":"PAID"}

   alice 讀 bob 的訂單 1002：
      [方法內] findOne(1002) 真的執行了，而且查了資料庫
   alice    → 403  {"status":403,"error":"Forbidden","path":"/api/m/one/1002"}
```

**第二組：403 是對的，但那句「方法內」的訊息也印出來了。** 這就是代價一：

```
代價一：資料【已經從資料庫查出來、進了 JVM 的記憶體】才被丟掉
        → 日誌、APM、記憶體 dump、GC 前的那一瞬間，都摸得到那筆資料
        → 3.8.3 會量出「載入 1 筆」vs「載入 0 筆」的差別
```

**代價二比較貴。** 如果那個方法**改了東西**呢？

```java
@Transactional
@PostAuthorize("hasRole('ADMIN')")
public Ord3 markShipped(Long id) {
    Ord3 o = repo.findById(id).orElseThrow();
    o.setStatus("SHIPPED");
    System.out.println("      [方法內] 已經把 " + id + " 改成 SHIPPED（交易還沒結束）");
    return o;
}
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m1"})
class PostAuthorizeTransactionTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static void show(String who, HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ");
        if (b.length() > 130) b = b.substring(0, 130) + "…";
        System.out.printf("   %-8s → %d  %s%n", who, r.statusCode(), b);
    }

    @Test
    void postAuthorizeVsTransaction() {
        System.out.println("\n═══ 3.5.6 🔴 @PostAuthorize 擋下來了，資料庫改了沒 ═══");
        Matrix m = new Matrix(port);
        System.out.println("   出貨前：" + m.send("GET", "/api/m/status/1001", "admin").body());
        System.out.println("\n   alice（不是 ADMIN）呼叫 POST /api/m/ship/1001：");
        show("alice", m.send("POST", "/api/m/ship/1001", "alice"));
        System.out.println("\n   出貨後：" + m.send("GET", "/api/m/status/1001", "admin").body());
    }
}
```

```
═══ 3.5.6 🔴 @PostAuthorize 擋下來了，資料庫改了沒 ═══
   出貨前：{"id":1001,"statusInDb":"PAID"}

   alice（不是 ADMIN）呼叫 POST /api/m/ship/1001：
      [方法內] 已經把 1001 改成 SHIPPED（交易還沒結束）
   alice    → 403  {"status":403,"error":"Forbidden","path":"/api/m/ship/1001"}

   出貨後：{"id":1001,"statusInDb":"SHIPPED"}
```

🔴 **HTTP 回應是 403，資料庫裡卻真的變成 `SHIPPED` 了。**

**為什麼交易沒有回滾？** `AccessDeniedException` 是 `RuntimeException`，
Spring 的預設交易規則「遇到 `RuntimeException` 就 rollback」明明是對的。
**問題出在誰包住誰**：

```java
package com.example.lab09.ch03;

import org.springframework.aop.Advisor;
import org.springframework.aop.framework.Advised;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.OrderUtils;

/** 把一個 Spring bean 的代理攔截器鏈（含 order）印出來 —— 3.5.6 的「為什麼」。 */
public class AdvisorReporter {

    public static void print(String label, Object bean) {
        System.out.println("\n──── " + label + " 的代理鏈 ────");
        System.out.println("實際型別：" + bean.getClass().getName());
        if (!(bean instanceof Advised advised)) {
            System.out.println("⚠️ 這個 bean【沒有】被代理 —— 所有方法層註解都不會生效");
            return;
        }
        System.out.printf("%-6s %-52s %s%n", "order", "Advisor", "說明");
        System.out.println("─".repeat(96));
        for (Advisor a : advised.getAdvisors()) {
            Object adv = a.getAdvice();
            int order = (a instanceof Ordered o) ? o.getOrder()
                    : (adv instanceof Ordered o2) ? o2.getOrder()
                    : java.util.Optional.ofNullable(OrderUtils.getOrder(adv.getClass()))
                                        .orElse(Ordered.LOWEST_PRECEDENCE);
            System.out.printf("%-6s %-52s %s%n", order == Ordered.LOWEST_PRECEDENCE ? "MAX" : order,
                    adv.getClass().getSimpleName(), hint(adv.getClass().getSimpleName()));
        }
        System.out.println("（order 小的在【外面】，先執行）");
    }

    static String hint(String cls) {
        return switch (cls) {
            case "AuthorizationManagerBeforeMethodInterceptor" -> "@PreAuthorize / @PreFilter";
            case "AuthorizationManagerAfterMethodInterceptor"  -> "@PostAuthorize / @PostFilter";
            case "TransactionInterceptor"                      -> "@Transactional";
            default -> "";
        };
    }
}
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.authorization.method.AuthorizationInterceptorsOrder;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest
@ActiveProfiles({"db", "ch3", "m1"})
class AdvisorOrderTest {

    @Autowired OrderService3 svc;

    @Test
    void advisorChain() {
        System.out.println("\n═══ 3.5.6 為什麼 @PostAuthorize 擋不住已經 commit 的交易 ═══");
        AdvisorReporter.print("OrderService3", svc);

        System.out.println("\n──── Spring Security 定義的攔截器順序（AuthorizationInterceptorsOrder）────");
        for (AuthorizationInterceptorsOrder o : AuthorizationInterceptorsOrder.values())
            System.out.printf("   %-28s %d%n", o.name(), o.getOrder());
        System.out.println("   （對照：@Transactional 的 TransactionInterceptor 預設 order = "
                + Integer.MAX_VALUE + "）");
    }
}
```

```
═══ 3.5.6 為什麼 @PostAuthorize 擋不住已經 commit 的交易 ═══

──── OrderService3 的代理鏈 ────
實際型別：com.example.lab09.ch03.OrderService3$$SpringCGLIB$$0
order  Advisor                                              說明
────────────────────────────────────────────────────────────────────────────────────────────────
100    PreFilterAuthorizationMethodInterceptor
200    AuthorizationManagerBeforeMethodInterceptor          @PreAuthorize / @PreFilter
500    AuthorizationManagerAfterMethodInterceptor           @PostAuthorize / @PostFilter
600    PostFilterAuthorizationMethodInterceptor
MAX    TransactionInterceptor                               @Transactional
（order 小的在【外面】，先執行）

──── Spring Security 定義的攔截器順序（AuthorizationInterceptorsOrder）────
   FIRST                        -2147483648
   PRE_FILTER                   100
   PRE_AUTHORIZE                200
   SECURED                      300
   JSR250                       400
   POST_AUTHORIZE               500
   POST_FILTER                  600
   LAST                         2147483647
   （對照：@Transactional 的 TransactionInterceptor 預設 order = 2147483647）
```

**答案就在最後一行：`TransactionInterceptor` 的 order 是 `Integer.MAX_VALUE`——它在【最裡面】。**

```
呼叫進來
  │
  ├─ 100  PreFilter
  ├─ 200  @PreAuthorize
  ├─ 500  @PostAuthorize        ← 檢查【在這一層】做
  ├─ 600  PostFilter
  └─ MAX  @Transactional        ← 交易在【這一層】開始與 commit
            │
            └─ markShipped() 真正的方法內容
            
            方法回傳 → 交易【commit】✅
       ← 回到 500 這一層 → @PostAuthorize 判定失敗 → 丟 AccessDeniedException
       
   例外往外拋，而交易早就 commit 了 —— 沒有任何東西會回滾它
```

📌 **三條可以直接用的規則**：

```
🔴 規則一：@PostAuthorize 只用在【唯讀】方法上。
          會寫資料的方法，一律用 @PreAuthorize 或方法內檢查。

✅ 規則二：真的需要「跑完才知道能不能給」又會寫資料的，把交易【拉到外層】——
          在 Controller 或一個更外面的 @Transactional 方法上開交易，
          讓 AccessDeniedException 在交易【內部】被拋出。

✅ 規則三：@PostAuthorize 的 SpEL 一定要處理 returnObject 為 null 的情況（實測見下）。
```

**規則三、以及 3.5.8 / 3.5.9 兩個佐證，用同一組類別跑出來**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.Profile;
import org.springframework.http.*;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.access.prepost.PostAuthorize;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/** 3.5 三個「看起來沒問題、實際上會出事」的行為。 */
public class ClaimCheck3 {

    @Service
    @Profile("m5")
    public static class NullReturnService {
        private final Ord3Repo repo;
        public NullReturnService(Ord3Repo repo) { this.repo = repo; }

        /** 🔴 SpEL 沒有處理 returnObject == null */
        @PostAuthorize("returnObject.ownerUsername == authentication.name")
        public Ord3 unsafe(Long id) { return repo.findById(id).orElse(null); }

        /** ✅ 有處理 */
        @PostAuthorize("returnObject == null or returnObject.ownerUsername == authentication.name")
        public Ord3 safe(Long id) { return repo.findById(id).orElse(null); }
    }

    /** 3.5.9：介面與實作標了【不同】的 @PreAuthorize */
    public interface Conflicting {
        @PreAuthorize("hasRole('ADMIN')")
        String both();
    }

    @Service
    @Profile("m6")
    public static class ConflictingImpl implements Conflicting {
        @Override
        @PreAuthorize("hasRole('USER')")          // ← 跟介面上那個不一樣
        public String both() { return "進來了"; }
    }

    /** ✅ 3.5.8 的修法：接住 AccessDeniedException 再原樣往外丟 */
    @RestControllerAdvice
    @Profile("m5")
    public static class SafeAdvice {
        @ExceptionHandler(AccessDeniedException.class)
        public void accessDenied(AccessDeniedException e) throws AccessDeniedException { throw e; }

        @ExceptionHandler(Exception.class)
        public ResponseEntity<Map<String, Object>> any(Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", "系統忙碌中，請稍後再試",
                                 "exception", e.getClass().getSimpleName()));
        }
    }

    @RestController
    @RequestMapping("/api/cc")
    @Profile("m5")
    public static class Api {
        private final NullReturnService svc;
        private final LegacyService3 legacy;
        Api(NullReturnService svc, LegacyService3 legacy) { this.svc = svc; this.legacy = legacy; }

        @GetMapping("/unsafe/{id}") public Object unsafe(@PathVariable Long id) { return svc.unsafe(id); }
        @GetMapping("/safe/{id}")   public Object safe(@PathVariable Long id)   { return svc.safe(id); }
        @GetMapping("/deny")        public Object deny()                        { return legacy.denyAll(); }
    }
}
```

**規則三的實測**（`unsafe` 的 SpEL 少了 `returnObject == null or`）：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.*;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m5"})
class NullReturnObjectTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired ClaimCheck3.NullReturnService nullSvc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static void show(String label, HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ");
        if (b.length() > 120) b = b.substring(0, 120) + "…";
        System.out.printf("   %-46s → %d  %s%n", label, r.statusCode(), b);
    }

    @Test
    void nullReturnObject() {
        System.out.println("\n═══ 3.5.6 @PostAuthorize 的 SpEL 沒處理 returnObject == null ═══");
        Matrix m = new Matrix(port);
        show("unsafe(1001) alice 自己的訂單", m.send("GET", "/api/cc/unsafe/1001", "alice"));
        show("unsafe(9999) 查無資料 → returnObject 是 null", m.send("GET", "/api/cc/unsafe/9999", "alice"));
        show("safe  (9999) SpEL 有寫 returnObject == null", m.send("GET", "/api/cc/safe/9999", "alice"));
    }

    /** HTTP 只看得到 500，例外訊息要直接呼叫 Service 才看得到 */
    @Test
    void nullReturnObjectMessage() {
        SecurityContext c = SecurityContextHolder.createEmptyContext();
        c.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(
                "alice", null, AuthorityUtils.createAuthorityList("ROLE_USER")));
        SecurityContextHolder.setContext(c);
        try { nullSvc.unsafe(9999L); }
        catch (Exception e) { System.out.println("   完整例外：" + e.getClass().getName() + ": " + e.getMessage()); }
        finally { SecurityContextHolder.clearContext(); }
    }
}
```

```
═══ 3.5.6 @PostAuthorize 的 SpEL 沒處理 returnObject == null ═══
   unsafe(1001) alice 自己的訂單                       → 200  {"id":1001,"ownerUsername":"alice",…}
   unsafe(9999) 查無資料 → returnObject 是 null        → 500  {"exception":"IllegalArgumentException",…}
   safe  (9999) SpEL 有寫 returnObject == null      → 200  
```

**完整例外**：

```
java.lang.IllegalArgumentException: Failed to evaluate expression 'returnObject.ownerUsername == authentication.name'
```

⚠️ **「查無資料」變成 500。** 而 500 是一個**攻擊者可以利用的訊號**——
它跟 200 / 403 都不一樣，等於在說「這個 id 不存在」。
**寫法就是多四個字**：

```java
@PostAuthorize("returnObject == null or returnObject.ownerUsername == authentication.name")
```

⚠️ **`@Transactional` 的 order 是可以改的**（`@EnableTransactionManagement(order = ...)`），
但**不要為了這件事去改它**——那會影響專案裡**所有**交易與所有 AOP 的相對順序。

### 3.5.7 實測：`@PreFilter` 與 `@PostFilter`

**這兩個註解不做「准 / 不准」，它們做的是【修改資料】**：

```
@PreFilter   把【傳進去的集合】裡不合規則的元素【移除】，方法收到的是刪減過的集合
@PostFilter  把【回傳的集合】裡不合規則的元素【移除】，呼叫端收到的是刪減過的集合
```

**`@PostFilter`**：

```java
@PostFilter("filterObject.ownerUsername == authentication.name")
public List<Ord3> allThenFilter() {
    List<Ord3> all = repo.findAll();
    System.out.println("      [方法內] 從資料庫撈回 " + all.size() + " 筆");
    return all;
}
```

**兩個註解各打一次**（`bulk-cancel` 是 3.1.1 那支 `MethodSecurityController` 的端點）：

```java
package com.example.lab09.ch03;

import com.example.lab09.Http;                  // 00 章 0.8.3
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.List;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m1"})
class FilterAnnotationTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static void show(String who, HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ");
        if (b.length() > 130) b = b.substring(0, 130) + "…";
        System.out.printf("   %-8s → %d  %s%n", who, r.statusCode(), b);
    }

    @Test
    void postFilter() {
        System.out.println("\n═══ 3.5.7 @PostFilter：先全部撈回來，再一筆一筆丟掉 ═══");
        Matrix m = new Matrix(port);
        System.out.println("\n   alice GET /api/m/filtered：");
        show("alice", m.send("GET", "/api/m/filtered", "alice"));
        System.out.println("\n   bob   GET /api/m/filtered：");
        show("bob", m.send("GET", "/api/m/filtered", "bob"));
    }

    @Test
    void preFilter() {
        System.out.println("\n═══ 3.5.7 @PreFilter：把不是你的參數先剃掉 ═══");
        Http http = new Http(port);
        // 三個人都送同一份 [1001,1002,1003]：1001 是 alice 的、1002 與 1003 是 bob 的
        for (String u : List.of("alice", "bob")) {
            HttpResponse<String> r = http.send("POST", "/api/m/bulk-cancel", "[1001,1002,1003]",
                    "Content-Type", "application/json", "Authorization", Http.basic(u, "pw"));
            System.out.printf("   %-6s 送出 [1001,1002,1003] → %d  服務端收到 %s 筆%n",
                    u, r.statusCode(), r.body());
        }
    }
}
```

```
═══ 3.5.7 @PostFilter：先全部撈回來，再一筆一筆丟掉 ═══

   alice GET /api/m/filtered：
      [方法內] 從資料庫撈回 3 筆
   alice    → 200  [{"id":1001,"ownerUsername":"alice","amount":1280.00,"status":"PAID"}]

   bob   GET /api/m/filtered：
      [方法內] 從資料庫撈回 3 筆
   bob      → 200  [{"id":1002,…},{"id":1003,…}]
```

**看起來很優雅：一行註解就做完了「只看得到自己的」。**
⚠️ **但注意「從資料庫撈回 3 筆」這一行——它跟登入的是誰完全無關。**
資料表只有 3 筆時沒事；3.8.5 會用 **10000 筆**證明這個做法為什麼不能上線。

**`@PreFilter`**：

```java
@PreFilter("filterObject.ownerUsername == authentication.name")
public int bulkCancel(List<Ord3> orders) {
    System.out.println("      [方法內] 收到 " + orders.size() + " 筆要取消");
    return orders.size();
}
```

```
═══ 3.5.7 @PreFilter：把不是你的參數先剃掉 ═══
      [方法內] 收到 1 筆要取消
   alice  送出 [1001,1002,1003] → 200  服務端收到 1 筆
      [方法內] 收到 2 筆要取消
   bob    送出 [1001,1002,1003] → 200  服務端收到 2 筆
```

⚠️ **注意狀態碼是 200，不是 403。**

```
alice 送了三筆（其中兩筆不是她的）→ 系統【安靜地】只處理了一筆，回 200
```

**這是 `@PreFilter` 最需要小心的地方**：它把「越權請求」變成「部分成功」。
使用者以為三筆都取消了，實際上只有一筆。

📌 **三條規則**：

```
① @PreFilter 適合「批次操作本來就允許部分成功」的場景（例如批次已讀）
🔴 不適合「要嘛全做要嘛不做」的場景 —— 那要自己檢查並回 403
② 兩個註解都要求參數 / 回傳值是【可變的】Collection —— 3.8.5 會看到不可變時的下場
③ filterObject 沒有型別資訊，SpEL 打錯欄位名只會在執行期爆
```

### 3.5.8 🔴 實測：一個 `@ExceptionHandler` 把 403 變成 500

**方法層的 `AccessDeniedException` 跟 URL 層的走【不同的路】。**

```
URL 層：AuthorizationFilter 丟出 AccessDeniedException
        ↓（還在 Filter Chain 裡）
        ExceptionTranslationFilter 接住 → AccessDeniedHandler → 403
        ★ 完全不會進到 DispatcherServlet，@ExceptionHandler 摸不到它

方法層：Service 裡的攔截器丟出 AccessDeniedException
        ↓
        往上冒到 Controller → DispatcherServlet
        ↓
        ★ 先經過你的 @ControllerAdvice / @ExceptionHandler
        ↓（如果沒人接）
        再往上冒到 ExceptionTranslationFilter → 403
```

**「如果沒人接」——而幾乎每個專案都有一個什麼都接的 handler**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.Profile;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

/** 🔴 一個「什麼都接」的 @RestControllerAdvice —— 3.5.8 的兇手 */
@RestControllerAdvice
@Profile("m4")
public class CatchAllAdvice {

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> any(Exception e) {
        Map<String, Object> body = new LinkedHashMap<>();      // ⚠️ Map.of() 不保證欄位順序
        body.put("error", "系統忙碌中，請稍後再試");
        body.put("exception", e.getClass().getSimpleName());
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
    }
}
```

**同一個使用者、同一種例外，分別從方法層與 URL 層各打一次**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m4"})          // ← m4 就是掛了 CatchAllAdvice 的那個
class SwallowedDeniedTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void catchAllAdviceEatsAccessDenied() {
        System.out.println("\n═══ 3.5.8 🔴 一個 @ExceptionHandler(Exception.class) 就把 403 變成 500 ═══");
        Matrix m = new Matrix(port);
        for (String[] c : new String[][]{
                {"GET", "/api/l/deny-all",    "方法層 @DenyAll（AccessDeniedException 從 Service 冒出來）"},
                {"GET", "/api/admin/revenue", "URL 層規則（AccessDeniedException 在 Filter 裡）"}}) {
            System.out.println("\n   " + c[2]);
            HttpResponse<String> r = m.send(c[0], c[1], "alice");
            System.out.printf("      alice %s %s → %d  %s%n", c[0], c[1], r.statusCode(), r.body());
        }
    }
}
```

```
═══ 3.5.8 🔴 一個 @ExceptionHandler(Exception.class) 就把 403 變成 500 ═══

   方法層 @DenyAll（AccessDeniedException 從 Service 冒出來）
      alice GET /api/l/deny-all → 500  {"error":"系統忙碌中，請稍後再試","exception":"AccessDeniedException"}

   URL 層規則（AccessDeniedException 在 Filter 裡）
      alice GET /api/admin/revenue → 403  {"status":403,"error":"Forbidden","path":"/api/admin/revenue"}
```

**同一個例外、同一個使用者、同一個服務，兩個狀態碼。**

⚠️ **後果比「狀態碼不好看」嚴重得多**：

```
① 前端拿到 500，會顯示「系統錯誤」而不是「你沒有權限」
② 你的告警系統會被「有人試圖越權」灌成「服務出錯」
③ 🔴 稽核紀錄不見了 —— AccessDeniedHandler 那一條路徑沒有被走到
④ 🔴 如果那個 handler 回的是 200（有些專案會回 {"success": false}），
     越權存取在監控上【完全消失】
```

**修法：在 catch-all 之前，明確處理 `AccessDeniedException` 並把它【往外丟】**
（完整可執行的版本在 3.5.6 的 `ClaimCheck3.SafeAdvice`）：

```java
/**
 * ✅ 明確接住它，然後【原樣往外丟】——
 * 讓 ExceptionTranslationFilter 的 AccessDeniedHandler 統一處理（01 章 1.8.5 的格式）。
 */
@ExceptionHandler(AccessDeniedException.class)
public void accessDenied(AccessDeniedException e) throws AccessDeniedException {
    throw e;
}

@ExceptionHandler(Exception.class)
public ResponseEntity<Map<String, Object>> any(Exception e) {
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(Map.of("error", "系統忙碌中，請稍後再試"));
}
```

**實測**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

/** m5 掛的是 ClaimCheck3.SafeAdvice —— 跟 m4 的差別只有多了一個 handler。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m5"})
class RethrowDeniedTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static void show(String label, HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ");
        if (b.length() > 120) b = b.substring(0, 120) + "…";
        System.out.printf("   %-46s → %d  %s%n", label, r.statusCode(), b);
    }

    @Test
    void rethrowKeeps403() {
        System.out.println("\n═══ 3.5.8 修法：接住 AccessDeniedException 再原樣往外丟 ═══");
        Matrix m = new Matrix(port);
        show("方法層 @DenyAll（有 SafeAdvice）", m.send("GET", "/api/cc/deny", "alice"));
        show("URL 層規則（對照組）", m.send("GET", "/api/admin/revenue", "alice"));
    }
}
```

```
═══ 3.5.8 修法：接住 AccessDeniedException 再原樣往外丟 ═══
   方法層 @DenyAll（有 SafeAdvice）                     → 403  {"status":403,"error":"Forbidden","path":"/api/cc/deny"}
   URL 層規則（對照組）                                   → 403  {"status":403,"error":"Forbidden","path":"/api/admin/revenue"}
```

✅ **兩條路徑回到同一個狀態碼、同一種格式。**

📌 **`@ExceptionHandler` 的比對是「最接近的父類優先」**，
所以 `AccessDeniedException.class` 一定會贏過 `Exception.class`。

⚠️ **不要在那個 handler 裡直接回 403 JSON。** 那會變成第三種錯誤格式
（Filter 層一種、Controller 層一種、這裡又一種）——01 章 1.8.5 花了整整一節在解決這件事。
**往外丟，讓出口只有一個。**

### 3.5.9 實測：註解寫在介面上

```java
public interface ReportApi {
    @PreAuthorize("hasRole('ADMIN')")
    String daily();

    String monthly();
}

@Service
public class LegacyService3 implements ReportApi {
    @Override public String daily()   { return "介面上的 @PreAuthorize 生效了"; }
    @Override public String monthly() { return "monthly 沒有任何註解"; }
}
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m3"})
class InterfaceAnnotationTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void annotationOnInterface() {
        System.out.println("\n═══ 3.5.9 註解寫在介面上 ═══");
        new Matrix(port).print("LegacyService3 implements ReportApi，@PreAuthorize 標在【介面】的 daily() 上",
                "GET /api/l/iface-daily",         // 介面上有 @PreAuthorize("hasRole('ADMIN')")
                "GET /api/l/iface-monthly");      // 對照組：兩邊都沒有註解
    }
}
```

```
═══ 3.5.9 註解寫在介面上 ═══

═══ LegacyService3 implements ReportApi，@PreAuthorize 標在【介面】的 daily() 上 ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/l/iface-daily              401      403      403      403      200
GET /api/l/iface-monthly            401      200      200      200      200
```

✅ **介面上的註解會生效。** 但本課**不推薦**這樣寫，理由有三個：

```
① 讀 LegacyService3.daily() 的人看不到任何授權規則 —— 要跳到介面才看得到
② 如果實作類別【也】標了一個不同的 @PreAuthorize，Spring Security 6 會拒絕猜你想要哪一個
③ 一個類別實作兩個介面、兩個介面都標了註解 → 同樣的衝突
```

**第 ② 點的實測**（介面標 `hasRole('ADMIN')`、實作標 `hasRole('USER')`）：

**這個要另外開一個 context**（m6），因為它要證明的是「**啟動不會失敗**」：

```java
package com.example.lab09.ch03;

import com.example.lab09.LabApp;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

class ConflictingAnnotationTest {

    @Test
    void conflictingAnnotations() {
        System.out.println("\n═══ 3.5.9 介面與實作標了【不同】的 @PreAuthorize ═══");
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(LabApp.class)
                .web(WebApplicationType.SERVLET)
                .profiles("db", "ch3", "m6")
                .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF")
                .run()) {
            ClaimCheck3.Conflicting c = ctx.getBean(ClaimCheck3.ConflictingImpl.class);
            System.out.println("   啟動成功。呼叫一次看看：");           // ★ 重點在這一行
            try { System.out.println("   " + c.both()); }
            catch (Exception e) { System.out.println("   " + e.getClass().getName() + ": " + e.getMessage()); }
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            System.out.println("   啟動失敗：" + root.getClass().getName());
            System.out.println("   " + root.getMessage());
        }
    }
}
```

```
═══ 3.5.9 介面與實作標了【不同】的 @PreAuthorize ═══
   啟動成功。呼叫一次看看：
   org.springframework.core.annotation.AnnotationConfigurationException:
     Found more than one annotation of type interface
     org.springframework.security.access.prepost.PreAuthorize attributed to
     public java.lang.String …ConflictingImpl.both()
     Please remove the duplicate annotations and publish a bean to handle your authorization logic.
```

⚠️ **注意「啟動成功」四個字。** 這個衝突**不會**在啟動時被發現，
它在**那個方法第一次被呼叫**時才爆——而且是 500，不是 403。

📌 **本課的規則：註解標在【實作類別】的 public 方法上，一個方法一個。**

**唯一的例外**：你在寫一個要給別人實作的 SPI，而那個授權規則是**契約的一部分**
（「不管誰來實作 `ReportApi.daily()`，都必須是 ADMIN 才能呼叫」）。

### 3.5.10 規則該寫在 Controller、Service，還是 Repository

| 位置 | 優點 | 缺點 | 適合 |
|---|---|---|---|
| **Controller** | 看得到 HTTP 語境；跟 URL 層規則放在一起好對照 | 換一個入口（排程、MQ）就不見了；Controller 變胖 | 「這支 API 誰能打」——其實 URL 層做得更好 |
| **Service** ✅ | 所有入口共用；跟商業邏輯在一起；好單元測試 | 要注意自我呼叫（3.5.5） | **絕大多數情況** |
| **Repository** | 最靠近資料，最難繞過 | 授權規則混進資料存取層；`findAll()` 這種通用方法沒辦法標 | ❌ 不建議標註解；但**把條件寫進查詢**是對的（3.8.2 做法 D） |

📌 **本課的分工建議**：

```
URL 層（SecurityConfig）      「這一整區要什麼身分」          —— 粗篩，擋掉 90% 的雜訊
方法層（Service 的 public）    「這個動作要什麼權限」          —— @PreAuthorize("hasAuthority('order:refund')")
資源層（Service 內部 / 查詢）   「這一筆是不是你的」            —— 3.8
```

⚠️ **不要在三層都寫同一條規則。** 重複的規則會**分岔**：
有人改了 URL 層忘了改方法層，於是你有一份「看起來很嚴格、實際上以最寬鬆那條為準」的設定。

---

## 3.6 把規則寫成程式碼

3.5.4 留下一個問題：**SpEL 是字串，打錯字不會有人告訴你。**

```java
@PreAuthorize("hasRole('ADMIM')")                        // 打錯 → 永遠 403
@PreAuthorize("#ownr == authentication.name")            // 打錯 → 永遠 403
@PreAuthorize("hasAuthority('order:refund') and #amount <= 100000 and " +
              "(#order.status == 'PAID' or hasRole('ADMIN'))")     // 這已經不該是字串了
```

### 3.6.1 三種擴充點

| 做法 | 規則寫在哪 | 編譯器看得到 | 可單元測試 | 適合 |
|---|---|---|---|---|
| **① SpEL 呼叫 bean** `@PreAuthorize("@guard.can(#id, authentication)")` | 一個一般的 `@Component` | ✅ 方法簽章 | ✅ | **絕大多數情況** |
| ② 自訂註解（meta-annotation） | 註解上，SpEL 只寫一次 | 部分 | ✅ | 同一條規則出現很多次 |
| ③ 自己寫 `AuthorizationManager` | 一個類別 | ✅ 全部 | ✅ | 規則跟「方法」無關（例如全域的租戶檢查） |

⚠️ **還有第四種：自訂 `MethodSecurityExpressionHandler`**（加一個 `hasScope(...)` 之類的函式）。
本課**不推薦**——它要你繼承 `SecurityExpressionRoot`，
而那個類別的 API 在 6.x 動過好幾次；升版時最容易壞的就是這種。
**想加函式，用做法 ①：`@scopes.has('order:write')` 完全等價，而且不會壞。**

### 3.6.2 實測：`@PreAuthorize("@orderGuard.canRead(#id, authentication)")`

```java
package com.example.lab09.ch03;

import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;

/**
 * 3.6.2：把授權規則寫成一個【一般的 bean】，讓 SpEL 呼叫它。
 * 好處：規則可以單元測試、可以下中斷點、可以注入 repository。
 */
@Component("orderGuard")
public class OrderGuard {

    private final Ord3Repo repo;
    public OrderGuard(Ord3Repo repo) { this.repo = repo; }

    public boolean canRead(Long id, Authentication auth) {
        if (auth == null) return false;
        boolean staff = auth.getAuthorities().stream()
                .anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN")
                            || a.getAuthority().equals("order:read:all"));
        if (staff) return true;
        boolean mine = repo.findById(id)
                .map(o -> o.getOwnerUsername().equals(auth.getName()))
                .orElse(false);
        System.out.println("      [orderGuard] " + auth.getName() + " 讀 " + id + " → " + mine);
        return mine;
    }
}
```

```java
@PreAuthorize("@orderGuard.canRead(#id, authentication)")
public Ord3 byBeanExpression(Long id, Ord3Repo repo) { return repo.findById(id).orElse(null); }
```

**`bean/{id}` 走 SpEL 呼叫 bean、`meta/{id}` 走 3.6.3 那個自訂註解**——
兩支端點的規則其實是同一個 `orderGuard`：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "m3"})
class CustomExpressionTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void customExpressions() {
        System.out.println("\n═══ 3.6.2 / 3.6.3 把規則寫成 bean、再包成註解 ═══");
        Matrix m = new Matrix(port);
        for (String path : new String[]{"/api/l/bean/1001", "/api/l/bean/1002",
                                        "/api/l/meta/1001", "/api/l/meta/1002"}) {
            System.out.println("\n   " + path + "（1001 是 alice 的、1002 是 bob 的）");
            // ★ alice 與 bob 同樣是 MEMBER —— 資源層的差別只有這兩個人擺在一起才看得出來
            for (String u : List.of("alice", "bob", "cs", "admin"))
                System.out.printf("      %-6s → %d%n", u, m.status("GET", path, u));
        }
    }
}
```

```
═══ 3.6.2 / 3.6.3 把規則寫成 bean、再包成註解 ═══

   /api/l/bean/1001（1001 是 alice 的、1002 是 bob 的）
      [orderGuard] alice 讀 1001 → true
      alice  → 200
      [orderGuard] bob 讀 1001 → false
      bob    → 403
      [orderGuard] cs 讀 1001 → false
      cs     → 403
      admin  → 200

   /api/l/bean/1002（1001 是 alice 的、1002 是 bob 的）
      [orderGuard] alice 讀 1002 → false
      alice  → 403
      [orderGuard] bob 讀 1002 → true
      bob    → 200
      [orderGuard] cs 讀 1002 → false
      cs     → 403
      admin  → 200
```

✅ **alice 與 bob 互看不到對方的訂單。這是本章第一次真正修掉 00 章 0.3.1。**

⚠️ **但 `cs`（客服）也被擋了。** `OrderGuard` 檢查的是 `order:read:all`，
而 `cs` 現在手上只有 `ROLE_CS_AGENT`——**權限還沒從資料表載進來**。
📌 **3.7 會把它接上，然後 `cs` 那兩格會自己變成 200，而 `OrderGuard` 一個字都不用改。**

**`admin` 那兩格沒有印出 `[orderGuard]`**，因為 `canRead` 第一段就 `return true` 了——
**代表管理員讀訂單時，`canRead` 完全不查資料庫**。這是把規則寫成方法的附帶好處：
你可以控制**檢查本身的成本**。

**它最大的價值是可以單元測試**：

```java
@Test
void 客服看得到所有訂單() {
    Authentication cs = UsernamePasswordAuthenticationToken.authenticated(
            "cs", null, AuthorityUtils.createAuthorityList("order:read:all"));
    assertThat(guard.canRead(1002L, cs)).isTrue();
}
```

**這種測試跑起來是毫秒等級的**，而且不需要啟動 Spring context、不需要 HTTP。
📌 **一條紀律**：`OrderGuard` 這種類別的**每一個分支都要有測試**——
它是你整個系統裡最不能出錯的一段程式碼。

### 3.6.3 實測：包成自訂註解

**如果同一句 SpEL 出現在十個方法上，把它包起來**：

```java
package com.example.lab09.ch03;

import org.springframework.security.access.prepost.PreAuthorize;

import java.lang.annotation.*;

/** 3.6.3：把一句很長的 SpEL 包成一個有名字的註解。 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@PreAuthorize("@orderGuard.canRead(#id, authentication)")
public @interface RequireOrderOwner {
}
```

```java
@RequireOrderOwner                                    // ★ 參數名一定要叫 id
public Ord3 byMetaAnnotation(Long id, Ord3Repo repo) { return repo.findById(id).orElse(null); }
```

```
   /api/l/meta/1001（1001 是 alice 的、1002 是 bob 的）
      [orderGuard] alice 讀 1001 → true
      alice  → 200
      [orderGuard] bob 讀 1001 → false
      bob    → 403
      cs     → 403
      admin  → 200

   /api/l/meta/1002
      alice  → 403
      bob    → 200
      cs     → 403
      admin  → 200
```

✅ **跟 3.6.2 完全一樣的結果，但呼叫端只看到 `@RequireOrderOwner`。**

⚠️ **代價**：那句 SpEL 裡的 `#id` 變成了一個**隱形的契約**。

```java
@RequireOrderOwner
public Ord3 read(Long orderId) { }     // 🔴 參數叫 orderId 不叫 id → #id 是 null → 永遠 403
```

📌 **兩個緩解方式**：

```
① 在註解的 Javadoc 第一行就寫「⚠️ 方法必須有一個叫 id 的參數」
② Spring Security 6.4 起支援【樣板化】的 meta-annotation
   （@PreAuthorize("hasRole('{value}')") 這種）—— 6.2 沒有，
   本課驗過：spring-security-core 6.2.4 的 jar 裡沒有 PrePostTemplateDefaults。
```

### 3.6.4 直接寫 `AuthorizationManager`

**規則跟「哪個方法」無關時**（例如「所有請求都必須帶對租戶」），
連 SpEL 都不用，直接寫一個 `AuthorizationManager` 掛在 URL 層：

```java
package com.example.lab09.ch03;

import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.authorization.AuthorizationManager;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.access.intercept.RequestAuthorizationContext;

import java.util.function.Supplier;

/** 3.6.4：路徑上的 userId 必須等於自己 —— 一條「便宜的」資源層規則（3.2.3 發現③）。 */
public class PathUserMustBeSelf
        implements AuthorizationManager<RequestAuthorizationContext> {

    @Override
    public AuthorizationDecision check(Supplier<Authentication> auth,
                                       RequestAuthorizationContext ctx) {
        Authentication me = auth.get();
        if (me == null || !me.isAuthenticated()) return new AuthorizationDecision(false);
        boolean admin = me.getAuthorities().stream()
                .anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"));
        String pathUser = ctx.getVariables().get("username");
        return new AuthorizationDecision(admin || me.getName().equals(pathUser));
    }
}
```

```java
.requestMatchers("/api/users/{username}/**").access(new PathUserMustBeSelf())
```

✅ **這一條完全不用碰資料庫**，因為「使用者名稱」就在路徑上。
📌 **只要授權需要的資訊【全部在請求裡】，就應該寫在這一層**——它是最便宜的。

### 3.6.5 三種做法的決策表

| 你的規則 | 用哪一個 |
|---|---|
| 「這個角色 / 這個權限」 | `hasRole` / `hasAuthority`，不要自己寫 |
| 「參數要等於我自己」 | `@PreAuthorize("#owner == authentication.name")` |
| 「路徑上的識別碼要等於我自己」 | `.access(自訂 AuthorizationManager)`（3.6.4）——**不用查資料庫** |
| 「要查資料庫才知道」 | `@PreAuthorize("@guard.can(...)")`（3.6.2）**或**乾脆寫進查詢條件（3.8.2 做法 D） |
| 同一條規則出現 5 次以上 | 再包成自訂註解（3.6.3） |
| 規則跟方法無關（租戶、IP 白名單） | 自訂 `AuthorizationManager` 掛在 URL 層 |

---

## 3.7 RBAC：角色與權限的資料模型

### 3.7.1 三種模型

```
① 角色即權限（Role-based，最單純）
     使用者 ──▸ 角色 ──▸ 規則直接寫角色
     .hasRole("ADMIN")
     ✅ 三個角色以內、規則不會變的小系統
     🔴 規則寫死在【程式碼】裡

② RBAC（Role-Based Access Control，本課的主線）
     使用者 ──▸ 角色 ──▸ 權限 ──▸ 規則寫權限
     .hasAuthority("order:refund")
     ✅ 角色與權限的對應關係在【資料表】裡，改權限不用重新部署
     ⚠️ 多兩張表、多一層概念

③ ABAC（Attribute-Based，屬性導向）
     規則 = f(使用者屬性, 資源屬性, 環境屬性)
     「同一個部門的、金額十萬以下的、上班時間內的」
     ✅ 表達力最強
     🔴 規則本身變成一套 DSL，難測、難稽核、難跟人解釋為什麼被擋
```

📌 **本課的立場**：**從 ② 開始。**
① 幾乎一定會演化成 ②（3.7.2 會示範那個過程），
而 ③ 通常只需要在**幾個特定的地方**用（3.6.2 那種寫成 Java 方法的 guard 就夠了），
不需要整套框架。

### 3.7.2 為什麼「角色即權限」會在半年後炸掉

**一個真實會發生的需求**：

> 「客服也要能退款，但只能退五千元以下的，而且不能刪訂單。」

**模型 ①（規則寫角色）要改的地方**：

```java
// SecurityConfig
- .requestMatchers(POST, "/api/orders/*/refund").hasRole("ADMIN")
+ .requestMatchers(POST, "/api/orders/*/refund").hasAnyRole("ADMIN", "CS_AGENT")

// OrderService
- @PreAuthorize("hasRole('ADMIN')")
+ @PreAuthorize("hasRole('ADMIN') or (hasRole('CS_AGENT') and #amount <= 5000)")

// 還有：後台選單、前端按鈕的顯示條件、報表的權限、批次任務…
```

```
要改的：程式碼           → 要 code review、要測試、要走發版流程
生效時間：下一次部署      → 通常是一到兩週
出錯的方式：漏改一處      → 某個角落客服還是進不去（或進得去太多）
```

**模型 ②（規則寫權限）要改的地方**：

```sql
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM app_role r, permission p
 WHERE r.code = 'CS_AGENT' AND p.code = 'order:refund';
```

```
要改的：一列資料         → 不用重新部署
生效時間：下一次登入      → 3.7.7 會量給你看
出錯的方式：權限給錯      → 一句 DELETE 就收回來了
```

⚠️ **「金額五千以下」那一段仍然要寫程式碼**——那是**業務規則**，不是權限。
📌 **分界線**：

```
「誰可以做這件事」     → 資料表（RBAC）
「這件事在什麼條件下成立」 → 程式碼（3.6.2 的 guard）
```

### 3.7.3 Schema：五張表

```
app_user ──┬── authority          （02 章：直接掛 authority 字串，最單純）
           │
           └── user_role ── app_role ── role_permission ── permission
                                        （03 章：多一層，換來「改權限不用部署」）
```

**兩套可以並存**：`authority` 表適合「這個人特別多一個權限」的例外，
`user_role` 那條路適合正常的角色指派。
⚠️ **但兩套並存要有紀律**——不然「為什麼這個人有這個權限」會變成一個沒人答得出來的問題。
**本課建議：新專案只用右邊那條，`authority` 表留給 02 章的教學。**

**五張表的完整 DDL 在 3.1.1。** 三個設計決定值得說明：

**① `app_role.code` 不含 `ROLE_` 前綴。**

```
資料表裡：ADMIN
載入時：  ROLE_ + ADMIN = ROLE_ADMIN
```

**前綴是 Spring Security 的約定，不是你的領域概念。**
存進資料庫等於把框架的細節洩漏到資料模型裡——換框架、換前綴（3.4.4）都會很痛。

**② `permission.code` 用 `資源:動作` 的形式。**

```
order:read        看訂單
order:read:all    看【所有人】的訂單     ← 注意這一個，3.8 會用到
order:refund      退款
order:delete      刪訂單
user:manage       管理帳號
report:read       看報表
```

**③ `role_permission` 與 `user_role` 都是純關聯表，沒有代理主鍵。**
複合主鍵 `(role_id, permission_id)` 本身就是唯一性約束，
**它讓「同一個權限給兩次」在資料庫層就不可能發生**。

### 3.7.4 實測：把三張表展開成 `GrantedAuthority`

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.*;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 3.7.4：從 user_role / role_permission / permission 三張表把權限展開成 GrantedAuthority。
 * 角色 → ROLE_XXX（給 hasRole 用）；權限 → order:refund（給 hasAuthority 用）。
 */
@Service
@Profile("rbac")
public class RbacUserDetailsService implements UserDetailsService {

    /** 只是為了 3.7.4 數呼叫次數；正式程式碼不需要 */
    public static final AtomicInteger QUERIES = new AtomicInteger();

    private final JdbcTemplate jdbc;
    public RbacUserDetailsService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        QUERIES.incrementAndGet();
        Map<String, Object> u;
        try {
            u = jdbc.queryForMap("""
                    SELECT id, username, password_hash, enabled, account_non_expired,
                           account_non_locked, credentials_expire_at
                      FROM app_user WHERE username = ?""", username);
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            throw new UsernameNotFoundException(username);           // ★ 02 章 2.5.5 規則一
        }

        QUERIES.incrementAndGet();
        // 一句 SQL 把「角色」與「該角色的權限」一起帶回來
        List<GrantedAuthority> auth = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        jdbc.query("""
                SELECT r.code AS role_code, p.code AS perm_code
                  FROM user_role ur
                  JOIN app_role r        ON r.id = ur.role_id
                  LEFT JOIN role_permission rp ON rp.role_id = r.id
                  LEFT JOIN permission p       ON p.id = rp.permission_id
                 WHERE ur.user_id = ?""",
                rs -> {
                    seen.add("ROLE_" + rs.getString("role_code"));   // ★ 前綴在【載入時】加，只加這一次
                    String p = rs.getString("perm_code");
                    if (p != null) seen.add(p);
                }, u.get("id"));
        seen.forEach(s -> auth.add(new SimpleGrantedAuthority(s)));

        java.sql.Timestamp exp = (java.sql.Timestamp) u.get("credentials_expire_at");
        return User.withUsername((String) u.get("username"))
                .password((String) u.get("password_hash"))
                .authorities(auth)
                .disabled(!(Boolean) u.get("enabled"))
                .accountExpired(!(Boolean) u.get("account_non_expired"))
                .accountLocked(!(Boolean) u.get("account_non_locked"))
                .credentialsExpired(exp != null && exp.toLocalDateTime().isBefore(java.time.LocalDateTime.now()))
                .build();
    }
}
```

**這一節的三段輸出由同一個測試類別產生**（第三個測試順便量成本）：

```java
package com.example.lab09.ch03;

import com.example.lab09.Http;                  // 00 章 0.8.3
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "rbac"})
class RbacTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    /** ① 三張表展開之後，每個人手上到底有什麼 */
    @Test
    void authoritiesFromThreeTables() {
        System.out.println("\n═══ 3.7.4 三張表展開成 GrantedAuthority ═══");
        Matrix m = new Matrix(port);
        for (String u : List.of("alice", "cs", "admin"))
            System.out.printf("   %-6s → %s%n", u, m.send("GET", "/api/me/authorities", u).body());
    }

    /** ② 規則只寫權限 —— 這份設定裡一個角色名稱都沒有 */
    @Test
    void rulesUsePermissions() {
        System.out.println("\n═══ 3.7.4 規則只寫權限，不寫角色 ═══");
        new Matrix(port).print("rbac：hasAuthority(\"user:manage\") / (\"report:read\") / (\"order:read\")",
                "GET /api/admin/revenue",
                "GET /api/reports/daily",
                "GET /api/orders/1001",
                "GET /api/hello");
    }

    /** ③ 成本：RbacUserDetailsService 內部有一個 QUERIES 計數器 */
    @Test
    void queryCount() {
        System.out.println("\n═══ 3.7.4 一次登入查幾句 SQL ═══");
        Http http = new Http(port);
        RbacUserDetailsService.QUERIES.set(0);
        for (int i = 0; i < 5; i++)
            http.get("/api/orders/1001", "Authorization", Http.basic("admin", "pw"));
        System.out.println("   無狀態 + Basic，5 個請求 → loadUserByUsername 內部查了 "
                + RbacUserDetailsService.QUERIES.get() + " 句 SQL");
    }
}
```

**每個帳號拿到什麼**：

```
═══ 3.7.4 三張表展開成 GrantedAuthority ═══
   alice  → {"name":"alice","authorities":["ROLE_MEMBER","order:read"]}
   cs     → {"name":"cs","authorities":["ROLE_CS_AGENT","order:read","order:read:all","order:refund"]}
   admin  → {"name":"admin","authorities":["ROLE_ADMIN","order:delete","order:read","order:read:all","order:refund","report:read","user:manage"]}
```

**規則現在【只寫權限】**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.access.expression.method.DefaultMethodSecurityExpressionHandler;
import org.springframework.security.access.hierarchicalroles.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

/** 3.7 RBAC 與角色階層。 */
public class RbacScenarios {

    /** rbac：權限從三張表載入，規則【只寫權限】 */
    @Configuration
    @EnableMethodSecurity
    @Profile("rbac & !rh & !sess3")
    static class RbacChain {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()
                    .requestMatchers("/api/admin/**").hasAuthority("user:manage")
                    .requestMatchers("/api/reports/**").hasAuthority("report:read")
                    .requestMatchers("/api/orders/**").hasAuthority("order:read")
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** rh：3.7.5 —— 只宣告一個 RoleHierarchy bean，什麼都不接 */
    @Configuration
    @EnableMethodSecurity
    @Profile("rbac & rh & !rh2")
    static class RoleHierarchyDeclaredOnly {
        @Bean
        static RoleHierarchy roleHierarchy() {
            RoleHierarchyImpl h = new RoleHierarchyImpl();
            h.setHierarchy("""
                    ROLE_ADMIN > ROLE_CS_AGENT
                    ROLE_CS_AGENT > ROLE_MEMBER""");
            return h;
        }

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()
                    .requestMatchers("/api/r/hasRole-MEMBER").hasRole("MEMBER")
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** rh2：3.7.5 修好之後 —— 多一個 methodSecurityExpressionHandler bean */
    @Configuration
    @EnableMethodSecurity
    @Profile("rbac & rh & rh2")
    static class RoleHierarchyWired {
        @Bean
        static RoleHierarchy roleHierarchy() {
            RoleHierarchyImpl h = new RoleHierarchyImpl();
            h.setHierarchy("""
                    ROLE_ADMIN > ROLE_CS_AGENT
                    ROLE_CS_AGENT > ROLE_MEMBER""");
            return h;
        }

        /** ★ 方法層要【自己接】 */
        @Bean
        static DefaultMethodSecurityExpressionHandler methodSecurityExpressionHandler(RoleHierarchy h) {
            DefaultMethodSecurityExpressionHandler handler = new DefaultMethodSecurityExpressionHandler();
            handler.setRoleHierarchy(h);
            return handler;
        }

        /** URL 層這條規則跟 rh 那組【一字不差】 */
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()
                    .requestMatchers("/api/r/hasRole-MEMBER").hasRole("MEMBER")
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** rbac + sess3：改成有 session —— 3.7.7 「權限改了多久生效」的對照組 */
    @Configuration
    @EnableMethodSecurity
    @Profile("rbac & sess3")
    static class RbacSessionChain {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()
                    .requestMatchers("/api/admin/**").hasAuthority("user:manage")
                    .anyRequest().authenticated())
                .httpBasic(h -> h.securityContextRepository(
                        new org.springframework.security.web.context.HttpSessionSecurityContextRepository()))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

```
═══ 3.7.4 規則只寫權限，不寫角色 ═══

═══ rbac：hasAuthority("user:manage") / ("report:read") / ("order:read") ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/admin/revenue              401      403      403      403      200
GET /api/reports/daily              401      403      403      403      200
GET /api/orders/1001                401      200      200      200      200
GET /api/hello                      401      200      200      200      200
```

📌 **這份設定裡一個角色名稱都沒有出現。**
「客服也要能看報表」這個需求，改的是 `role_permission` 一列資料，
**`SecurityConfig` 一個字都不用動。**

**成本**：

```
═══ 3.7.4 一次登入查幾句 SQL ═══
   無狀態 + Basic，5 個請求 → loadUserByUsername 內部查了 10 句 SQL
```

**每個請求 2 句**（一句查帳號、一句查角色與權限）。
⚠️ **無狀態 + Basic 的每一個請求都會重跑這兩句**（02 章 2.7.4 量過同一件事）。
📌 **三個處理方向**：

```
① 改用 session（02 章 2.7.4）—— 後續請求 0 句，代價見 3.7.7
② 改用 JWT，把 authorities 放進 token（05 章）—— 0 句，代價也是 3.7.7
③ 加快取 —— 02 章 2.7.8 量過 UserCache 的坑，不要用預設值
```

### 3.7.5 🔴 實測：`RoleHierarchy` 在兩層的待遇不同

**「管理員自動擁有客服的所有權限」這種需求，Spring Security 有內建**：

```java
@Bean
static RoleHierarchy roleHierarchy() {
    RoleHierarchyImpl h = new RoleHierarchyImpl();
    // ⚠️ 6.2 用 setHierarchy(String)；6.3 起改成 RoleHierarchyImpl.fromHierarchy()
    h.setHierarchy("""
            ROLE_ADMIN > ROLE_CS_AGENT
            ROLE_CS_AGENT > ROLE_MEMBER""");
    return h;
}
```

**只宣告這一個 bean，什麼都不接。兩層各測一次**——
**兩支端點的規則文字一字不差**（`hasRole('MEMBER')`）：

```java
// URL 層
.requestMatchers("/api/r/hasRole-MEMBER").hasRole("MEMBER")

// 方法層
@PreAuthorize("hasRole('MEMBER')")
public String memberOnly() { return "進來了"; }
```

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.Profile;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;

/** 3.7.5：同一句 hasRole('MEMBER')，在 URL 層與方法層各測一次。 */
@Service
@Profile("rh")
public class HierarchyService {

    @PreAuthorize("hasRole('MEMBER')")
    public String memberOnly() { return "進來了"; }

    @RestController
    @RequestMapping("/api/h")
    @Profile("rh")
    static class Api {
        private final HierarchyService svc;
        Api(HierarchyService svc) { this.svc = svc; }
        @GetMapping("/member") public Object member() { return svc.memberOnly(); }
    }
}
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** rh：宣告了 RoleHierarchy bean，但【什麼都沒接】。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "rbac", "rh"})
class RoleHierarchyTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void declaredOnly() {
        System.out.println("""
                
                ═══ 3.7.5 只宣告一個 RoleHierarchy bean，會自動生效嗎 ═══
                階層：ROLE_ADMIN > ROLE_CS_AGENT > ROLE_MEMBER
                帳號：alice=[ROLE_MEMBER…]  cs=[ROLE_CS_AGENT…]  admin=[ROLE_ADMIN…]
                兩支端點的規則【文字一模一樣】：hasRole('MEMBER')""");
        new Matrix(port).print("rh：URL 層 vs 方法層",
                "GET /api/r/hasRole-MEMBER",     // URL 層規則
                "GET /api/h/member");            // 方法層 @PreAuthorize
    }
}
```

```
═══ 3.7.5 只宣告一個 RoleHierarchy bean，會自動生效嗎 ═══
階層：ROLE_ADMIN > ROLE_CS_AGENT > ROLE_MEMBER
帳號：alice=[ROLE_MEMBER…]  cs=[ROLE_CS_AGENT…]  admin=[ROLE_ADMIN…]
兩支端點的規則【文字一模一樣】：hasRole('MEMBER')

═══ rh：URL 層 vs 方法層 ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/r/hasRole-MEMBER           401      200      200      200      200
GET /api/h/member                   401      200      200      403      403
```

🔴 **同一句規則，URL 層吃到了階層、方法層沒有。**

```
URL 層   cs → 200、admin → 200      ✅ ROLE_ADMIN > ROLE_CS_AGENT > ROLE_MEMBER 被套用了
方法層   cs → 403、admin → 403      🔴 只有真的持有 ROLE_MEMBER 的 alice / bob 通過
```

⚠️ **這個不一致最危險的地方是它的方向**：
**URL 層比較寬鬆、方法層比較嚴格。**
如果你只用 URL 層測試，一切正常；等到有人把規則搬到 `@PreAuthorize`，管理員突然進不去。
**反過來也可能發生**——你以為方法層擋住了，其實 URL 層早就放行了。

**修法：把 `RoleHierarchy` 明確接到方法層的運算式處理器**
（就是上面 `RbacScenarios.RoleHierarchyWired` 多出來的那個 bean）：

```java
/** ★ 方法層要【自己接】—— URL 層會自動吃到 RoleHierarchy bean，方法層不會 */
@Bean
static DefaultMethodSecurityExpressionHandler methodSecurityExpressionHandler(RoleHierarchy h) {
    DefaultMethodSecurityExpressionHandler handler = new DefaultMethodSecurityExpressionHandler();
    handler.setRoleHierarchy(h);
    return handler;
}
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** rh2：只比 rh 多了一個 methodSecurityExpressionHandler bean。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "rbac", "rh", "rh2"})
class RoleHierarchyWiredTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void wiredToBothLayers() {
        System.out.println("\n═══ 3.7.5 把 RoleHierarchy 明確接到兩層之後 ═══");
        new Matrix(port).print("rh2：URL 層不用改，方法層換掉 ExpressionHandler",
                "GET /api/r/hasRole-MEMBER",
                "GET /api/h/member");
    }
}
```

```
═══ 3.7.5 把 RoleHierarchy 明確接到兩層之後 ═══

═══ rh2：URL 層不用改，方法層換掉 ExpressionHandler ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/r/hasRole-MEMBER           401      200      200      200      200
GET /api/h/member                   401      200      200      200      200
```

✅ **兩層一致了。**

⚠️ **`methodSecurityExpressionHandler` 這個 bean 一定要 `static`**——
理由跟 3.4.4 的 `GrantedAuthorityDefaults` 一樣：它要在 bean 後處理階段就準備好。

📌 **本課對 `RoleHierarchy` 的立場：能不用就不用。**

```
🔴 它讓「這個人到底有什麼權限」變成一個要推導的問題
🔴 它跟 RBAC 重疊 —— 3.7.3 那張 role_permission 表已經可以表達「管理員有客服的全部權限」
     只是要多插幾列資料，而那幾列是【看得見的】
✅ 唯一適合它的場景：階層真的很深（五層以上組織架構），而且展開後的資料列會爆炸
```

### 3.7.6 權限命名慣例

```
✅ 動詞式、有命名空間、全小寫
     order:read        order:read:all        order:refund       order:delete
     user:manage       report:read           report:export

❌ 用角色當權限名
     ADMIN_PERMISSION   CS_PERMISSION        ← 那只是換一個名字的角色

❌ 用畫面當權限名
     order_page_view    order_page_edit      ← 換一版 UI 就全部要改

❌ 用 CRUD 當唯一的動詞
     order:update       ← 「改地址」跟「改金額」是完全不同的風險等級
     order:change-address / order:change-amount   ✅
```

📌 **一個判準**：

> **權限的名字要能讓【產品經理】看懂，而不是只有工程師看懂。**
> 因為決定「客服能不能退款」的人是他，不是你。

### 3.7.7 實測：權限收回來，多久生效

**這是 RBAC 最容易被忽略的一個問題。**

```java
package com.example.lab09.ch03;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

/** sess3：把 3.7.4 那條 chain 改成【有 session】。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "rbac", "sess3"})
class PermissionLatencyTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static String session(HttpResponse<String> r) {
        return r.headers().allValues("set-cookie").stream()
                .filter(c -> c.startsWith("JSESSIONID="))
                .map(c -> c.substring("JSESSIONID=".length()).split(";")[0])
                .findFirst().orElse(null);
    }

    @Test
    void revokeWhileLoggedIn() {
        System.out.println("\n═══ 3.7.7 把權限收回來，多久生效 ═══");
        Http http = new Http(port);

        HttpResponse<String> first = http.get("/api/admin/revenue", "Authorization", Http.basic("admin", "pw"));
        String sid = session(first);
        System.out.println("   ① admin 用 Basic 登入 → " + first.statusCode() + "，拿到 JSESSIONID=" + sid);

        int n = jdbc.update("""
                DELETE rp FROM role_permission rp
                  JOIN app_role r  ON r.id = rp.role_id
                  JOIN permission p ON p.id = rp.permission_id
                 WHERE r.code = 'ADMIN' AND p.code = 'user:manage'""");
        System.out.println("   ② 在資料庫把 ADMIN 的 user:manage 權限刪掉（影響 " + n + " 列）");

        System.out.println("   ③ 用【同一個 session】再打一次   → "
                + http.get("/api/admin/revenue", "Cookie", "JSESSIONID=" + sid).statusCode());
        System.out.println("   ④ 用【新的 Basic 認證】再打一次    → "
                + http.get("/api/admin/revenue", "Authorization", Http.basic("admin", "pw")).statusCode());
    }
}
```

```
═══ 3.7.7 把權限收回來，多久生效 ═══
   ① admin 用 Basic 登入 → 200，拿到 JSESSIONID=437E4F1661ABB473783CC643077CC58B
   ② 在資料庫把 ADMIN 的 user:manage 權限刪掉（影響 1 列）
   ③ 用【同一個 session】再打一次   → 200
   ④ 用【新的 Basic 認證】再打一次    → 403
```

🔴 **權限已經從資料庫刪掉了，那個 session 還是 200。**

**因為 `authorities` 是在【認證那一刻】被讀進 `Authentication` 物件的，
之後就跟資料庫沒有任何關係了。** 這跟 02 章 2.7.7「帳號停用後舊 session 還能用」是同一件事的另一面。

**四種身分載體的生效時間**：

| 身分怎麼帶 | 權限改了多久生效 | 為什麼 |
|---|---|---|
| 無狀態 + Basic（3.7.4） | **下一個請求** | 每個請求都重新 `loadUserByUsername` |
| Session | **下一次登入** | `SecurityContext` 存在 session 裡 |
| JWT（05 章） | **token 過期** | authorities 寫在 token payload 裡 |
| JWT + 每次查 DB | 下一個請求 | 那就等於放棄 JWT 的好處了 |

📌 **三個處理方向**（05 章 / 08 章會展開）：

```
① 接受它，但把 token / session 的存活時間縮短（例如 15 分鐘）
② 收回權限時【主動】作廢那個人的 session（SessionRegistry，02 章 2.7.7）
③ 高風險動作（退款、刪除、改密碼）在【方法層】即時查一次資料庫
     @PreAuthorize("@permissionService.hasLive(authentication.name, 'order:refund')")
```

⚠️ **不要三個都不做，然後在事故報告上寫「權限已於當天收回」**——
如果那個人的 session 還活著，那句話是不成立的。

---

## 3.8 資源層授權：這筆資料是不是你的 ★

### 3.8.1 實測：00 章 0.3.1 那個事故，到現在還在

**把前面所有東西都做對之後**——帳號在資料庫、密碼是 BCrypt、
URL 層規則寫齊了、方法層註解也上了——**這個洞還在**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

/** 3.8 資源層授權：URL 層只保留「要登入」，剩下全部是資料的事。 */
public class ResourceScenarios {

    @Configuration
    @EnableMethodSecurity
    @Profile("res")
    static class ResChain {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error").permitAll()
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**alice 與 bob 都是 `MEMBER`**——這張表的重點就在他們兩個那兩欄：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "res"})
class ResourceLayerTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void theBug() {
        System.out.println("\n═══ 3.8.1 00 章 0.3.1 那個事故，到現在還在 ═══");
        new Matrix(port).print(
                "res：URL 層只有 anyRequest().authenticated()（1001 是 alice 的、1002 是 bob 的）",
                "GET /api/orders/1001",
                "GET /api/orders/1002",          // ★ alice 這一格就是那個事故
                "GET /api/orders");
    }
}
```

```
═══ 3.8.1 00 章 0.3.1 那個事故，到現在還在 ═══

═══ res：URL 層只有 anyRequest().authenticated()（1001 是 alice 的、1002 是 bob 的） ═══
請求                                匿名     alice    bob      cs       admin
─────────────────────────────────────────────────────────────────────────────────
GET /api/orders/1001                401      200      200      200      200
GET /api/orders/1002                401      200      200      200      200
GET /api/orders                     401      200      200      200      200
```

**第二列：alice 讀 bob 的訂單 → 200。**

⚠️ **注意這張矩陣「看起來」很正常。**

```
匿名那一欄全部 401   ✅ 認證有做
其他四欄全部 200     ✅ 「登入的會員都能看訂單」—— 需求就是這樣寫的啊
```

📌 **這就是資源層授權的難處**：

```
① 授權矩陣的維度是「端點 × 角色」，而這個洞是「同角色的不同人」—— 維度上就看不到
② 每一格都是 200，而 200 是【預期的】—— 沒有任何異常訊號
③ 規則本身（「訂單只有本人看得到」）從來沒有被寫在任何一個設定檔裡
```

**這一類漏洞有一個名字：IDOR（Insecure Direct Object Reference）**，
OWASP API Security Top 10 的**第一名**（API1:2023 Broken Object Level Authorization）。

### 3.8.2 四個做法，四個位置

**同一件事——「這筆訂單是不是你的」——有四個寫法**：

```java
package com.example.lab09.ch03;

import org.springframework.context.annotation.Profile;
import org.springframework.data.domain.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.access.prepost.*;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/** 3.8.2：同一件事（「這筆訂單是不是你的」）的四種寫法。 */
@Service
@Profile("res")
public class OwnershipService {

    private final Ord3Repo repo;
    public OwnershipService(Ord3Repo repo) { this.repo = repo; }

    static boolean isStaff(Authentication a) {
        return a.getAuthorities().stream().anyMatch(g -> g.getAuthority().equals("ROLE_ADMIN"));
    }

    /** 做法 A：查出來，在【呼叫端】比對 —— 這一版把檢查散在 Controller 裡 */
    public Ord3 loadRaw(Long id) {
        return repo.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    /** 做法 B：查出來，在 Service 裡比對 —— 檢查跟資料在同一個地方 */
    public Ord3 loadChecked(Long id, Authentication me) {
        Ord3 o = repo.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (!isStaff(me) && !o.getOwnerUsername().equals(me.getName()))
            throw new AccessDeniedException("不是你的訂單");
        return o;
    }

    /** 做法 C：@PostAuthorize —— 檢查看得見，但方法一定會先跑完 */
    @PostAuthorize("returnObject.ownerUsername == authentication.name or hasRole('ADMIN')")
    public Ord3 loadPostAuthorize(Long id) {
        return repo.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    /** 做法 D：把「是誰的」寫進【查詢條件】—— 不是你的，資料庫就不會回給你 */
    public Ord3 loadScoped(Long id, Authentication me) {
        if (isStaff(me)) return repo.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        return repo.findByIdAndOwnerUsername(id, me.getName())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    // ───────── 列表：過濾 vs 查詢條件（3.8.5）─────────

    /** 🔴 分頁 + @PostFilter */
    @PostFilter("filterObject.ownerUsername == authentication.name")
    public List<Ord3> pageThenFilter(int page, int size) {
        Page<Ord3> p = repo.findAll(PageRequest.of(page, size, Sort.by("id")));
        System.out.println("      [方法內] 資料庫回了 " + p.getNumberOfElements()
                + " 筆（total=" + p.getTotalElements() + "）");
        return p.getContent();
    }

    /** 🔴 變體：把 Page 的內容【複製】成可變 list，才不會 500 —— 但分頁數字還是壞的 */
    @PostFilter("filterObject.ownerUsername == authentication.name")
    public List<Ord3> pageThenFilterMutable(int page, int size) {
        Page<Ord3> p = repo.findAll(PageRequest.of(page, size, Sort.by("id")));
        System.out.println("      [方法內] 資料庫回了 " + p.getNumberOfElements()
                + " 筆（total=" + p.getTotalElements() + "）");
        return new java.util.ArrayList<>(p.getContent());
    }

    /** ✅ 把擁有者寫進查詢 */
    public Page<Ord3> pageScoped(String owner, int page, int size) {
        Page<Ord3> p = repo.findByOwnerUsername(owner, PageRequest.of(page, size, Sort.by("id")));
        System.out.println("      [方法內] 資料庫回了 " + p.getNumberOfElements()
                + " 筆（total=" + p.getTotalElements() + "）");
        return p;
    }

    // ───────── 3.8.7 資料範圍：讓「只看得到自己的」變成資料庫層的預設 ─────────

    @jakarta.persistence.PersistenceContext
    private jakarta.persistence.EntityManager em;

    /** 沒有開 filter：findAll() 就是 findAll() */
    @Transactional(readOnly = true)
    public int countAllNoFilter() { return repo.findAll().size(); }

    /** 開了 filter：同一句 repo.findAll()，SQL 自動多一段 WHERE */
    @Transactional(readOnly = true)
    public int countAllWithFilter(String owner) {
        em.unwrap(org.hibernate.Session.class)
          .enableFilter("ownerScope")
          .setParameter("owner", owner);
        return repo.findAll().size();
    }

    // ───────── 寫入：先查再改的時間差（3.8.6）─────────

    /** 🔴 查一次、比一次、改一次 —— 中間有兩個時間差 */
    @Transactional
    public String cancelReadThenWrite(Long id, Authentication me) {
        Ord3 o = repo.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (!o.getOwnerUsername().equals(me.getName()))
            throw new AccessDeniedException("不是你的訂單");
        o.setStatus("CANCELLED");
        return "已取消 " + id;
    }

    /** ✅ 把擁有者寫進 UPDATE 的 WHERE —— 一句 SQL，沒有時間差 */
    @Transactional
    public String cancelScoped(Long id, Authentication me) {
        int n = repo.cancelOwned(id, me.getName());
        if (n == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        return "已取消 " + id + "（影響 " + n + " 列）";
    }
}
```

**四個做法的位置**：

```
做法 A   Controller 裡        Ord3 o = svc.loadRaw(id);
                             if (!isStaff(me) && !o.getOwnerUsername().equals(me.getName())) throw …

做法 B   Service 裡           查完就比，比不過就丟 AccessDeniedException

做法 C   @PostAuthorize       檢查寫在註解上，方法本身完全乾淨

做法 D   查詢條件             findByIdAndOwnerUsername(id, me.getName())
```

### 3.8.3 實測：四個做法的成本

**用 Hibernate 的 `Statistics` 量「打了幾句 SQL、載入了幾個 entity」。**
⚠️ **要直接呼叫 Service，不能走 HTTP**——不然 Basic 認證那兩句查詢會混進來（3.7.4）。

```java
package com.example.lab09.ch03;

import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.springframework.stereotype.Component;

/** 量「這一次呼叫打了幾句 SQL」——08 站 00 章那把尺，搬過來量授權。 */
@Component
public class Sql3 {

    private final Statistics stats;

    public Sql3(EntityManagerFactory emf) {
        this.stats = emf.unwrap(SessionFactory.class).getStatistics();
        this.stats.setStatisticsEnabled(true);
    }

    public void reset() { stats.clear(); }
    public long statements() { return stats.getPrepareStatementCount(); }
    public long entitiesLoaded() { return stats.getEntityLoadCount(); }
}
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.*;
import org.springframework.test.context.ActiveProfiles;

import java.util.function.Supplier;

/**
 * 3.8.3：直接呼叫 Service（不經過 HTTP），
 * 這樣量到的 SQL 就【只有授權那件事】—— 認證那一句不會混進來。
 */
@SpringBootTest
@ActiveProfiles({"db", "ch3", "res"})
class FourWaysSqlTest {

    @Autowired OwnershipService svc;
    @Autowired Sql3 sql;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }
    @AfterEach  void clear() { SecurityContextHolder.clearContext(); }

    static Authentication as(String name, String... authorities) {
        return UsernamePasswordAuthenticationToken.authenticated(
                name, null, AuthorityUtils.createAuthorityList(authorities));
    }

    void login(Authentication a) {
        SecurityContext c = SecurityContextHolder.createEmptyContext();
        c.setAuthentication(a);
        SecurityContextHolder.setContext(c);
    }

    String run(Supplier<Object> call) {
        sql.reset();
        String outcome;
        try { call.get(); outcome = "成功"; }
        catch (Exception e) { outcome = e.getClass().getSimpleName(); }
        return String.format("%-32s SQL %d 句、載入 %d 筆", outcome, sql.statements(), sql.entitiesLoaded());
    }

    @Test
    void fourWays() {
        Authentication alice = as("alice", "ROLE_MEMBER");
        login(alice);
        System.out.println("""
                
                ═══ 3.8.3 四種做法的成本（alice 直接呼叫 Service，沒有 HTTP、沒有認證查詢）═══
                訂單 1001 是 alice 的、1002 是 bob 的。""");
        System.out.printf("%n%-4s %-40s %-46s %s%n", "做法", "說明", "讀 1001（自己的）", "讀 1002（別人的）");
        System.out.println("─".repeat(140));
        System.out.printf("%-4s %-40s %-46s %s%n", "A/B", "查出來再比對（loadChecked）",
                run(() -> svc.loadChecked(1001L, alice)), run(() -> svc.loadChecked(1002L, alice)));
        System.out.printf("%-4s %-40s %-46s %s%n", "C", "@PostAuthorize",
                run(() -> svc.loadPostAuthorize(1001L)), run(() -> svc.loadPostAuthorize(1002L)));
        System.out.printf("%-4s %-40s %-46s %s%n", "D", "查詢條件（findByIdAndOwnerUsername）",
                run(() -> svc.loadScoped(1001L, alice)), run(() -> svc.loadScoped(1002L, alice)));

        System.out.println("\n── 換成 admin（ROLE_ADMIN）讀 bob 的 1002");
        Authentication admin = as("admin", "ROLE_ADMIN");
        login(admin);
        System.out.printf("   %-40s %s%n", "查出來再比對", run(() -> svc.loadChecked(1002L, admin)));
        System.out.printf("   %-40s %s%n", "@PostAuthorize", run(() -> svc.loadPostAuthorize(1002L)));
        System.out.printf("   %-40s %s%n", "查詢條件", run(() -> svc.loadScoped(1002L, admin)));
    }
}
```

```
═══ 3.8.3 四種做法的成本（alice 直接呼叫 Service，沒有 HTTP、沒有認證查詢）═══
訂單 1001 是 alice 的、1002 是 bob 的。

做法   說明                                       讀 1001（自己的）                                    讀 1002（別人的）
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
A/B  查出來再比對（loadChecked）                      成功                               SQL 1 句、載入 1 筆 AccessDeniedException            SQL 1 句、載入 1 筆
C    @PostAuthorize                           成功                               SQL 1 句、載入 1 筆 AccessDeniedException            SQL 1 句、載入 1 筆
D    查詢條件（findByIdAndOwnerUsername）           成功                               SQL 1 句、載入 1 筆 ResponseStatusException          SQL 1 句、載入 0 筆

── 換成 admin（ROLE_ADMIN）讀 bob 的 1002
   查出來再比對                                   成功                               SQL 1 句、載入 1 筆
   @PostAuthorize                           成功                               SQL 1 句、載入 1 筆
   查詢條件                                     成功                               SQL 1 句、載入 1 筆
```

**關鍵那一格：被拒絕時載入了幾筆。**

```
做法 A / B / C   載入 1 筆      ← bob 的訂單資料【已經進了 JVM 的記憶體】
做法 D           載入 0 筆      ← 資料【從來沒有離開資料庫】
```

⚠️ **「載入 1 筆」意味著什麼？**

```
① 那筆資料出現在 Hibernate 的一級快取裡
② 它可能被寫進 SQL 日誌、APM 的 trace、記憶體 dump
③ 如果那個方法在丟例外【之前】做了別的事（記 log、發事件、寫稽核），資料就跟著跑出去了
④ 🔴 如果是 3.5.6 那種會【寫】資料的方法，交易已經 commit 了
```

**四個做法的完整對照**：

| | A：Controller | B：Service | C：`@PostAuthorize` | D：查詢條件 |
|---|---|---|---|---|
| 規則寫在哪 | Controller | Service | 註解 | Repository 方法名 |
| 換一個入口還在嗎 | ❌ 不在 | ✅ 在 | ✅ 在 | ✅ 在 |
| 被拒時資料離開 DB 了嗎 | 是 | 是 | 是 | **否** |
| 被拒時的例外 | 你決定 | 你決定 | `AccessDeniedException` | 「查無資料」 |
| 預設狀態碼 | 你決定 | 403 | 403 | 404 |
| 能寫複雜規則嗎 | ✅ | ✅ | ⚠️ 只能寫 SpEL | ❌ 只能寫查詢條件 |
| 會寫資料的方法能用嗎 | ✅ | ✅ | 🔴 **不行**（3.5.6） | ✅ |
| 規則看得見嗎 | ⚠️ 散在各處 | ⚠️ 要讀方法內容 | ✅ 註解一眼看到 | ⚠️ 藏在方法名裡 |

📌 **本課的建議**：

```
✅ 預設用 D（查詢條件）—— 它是唯一「資料不會離開資料庫」的做法，
   而且它順便解決了 3.8.5 的列表問題與 3.8.6 的寫入問題

✅ 規則太複雜、查詢條件寫不下時，用 B（Service 裡檢查）+ 3.6.2 的 guard bean

⚠️ C（@PostAuthorize）只用在【唯讀且規則簡單】的方法上 —— 它的好處是規則看得見

🔴 A（Controller）不要用 —— 換一個入口就全部不見了
```

### 3.8.4 403 還是 404：完整判準

**`b` 與 `b404` 是同一個 Service 方法，差別只在 Controller 怎麼轉換例外**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "res"})
class Status403vs404Test {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void status403vs404() {
        System.out.println("\n═══ 3.8.4 403 還是 404 ═══");
        Matrix m = new Matrix(port);
        // 1002 是 bob 的（存在但不是你的）、9999 根本不存在 —— 比的就是這兩種情況分不分得出來
        for (String[] c : new String[][]{
                {"/api/res/b/1002",    "回 403「不是你的訂單」"},
                {"/api/res/b404/1002", "回 404「找不到」"},
                {"/api/res/b/9999",    "訂單根本不存在"},
                {"/api/res/b404/9999", "訂單根本不存在"}}) {
            HttpResponse<String> r = m.send("GET", c[0], "alice");
            String b = r.body() == null ? "" : r.body().replace("\n", " ");
            if (b.length() > 90) b = b.substring(0, 90) + "…";
            System.out.printf("   %-24s %-24s → %d  %s%n", c[0], c[1], r.statusCode(), b);
        }
    }
}
```

```
═══ 3.8.4 403 還是 404 ═══
   /api/res/b/1002          回 403「不是你的訂單」            → 403  {"status":403,"error":"Forbidden","path":"/api…
   /api/res/b404/1002       回 404「找不到」               → 404  {"status":404,"error":"Not Found","path":"/api…
   /api/res/b/9999          訂單根本不存在                  → 404  {"status":404,"error":"Not Found","path":"/api…
   /api/res/b404/9999       訂單根本不存在                  → 404  {"status":404,"error":"Not Found","path":"/api…
```

**看第一列與第三列**：

```
訂單 1002 存在，但不是你的  → 403
訂單 9999 根本不存在        → 404
```

🔴 **攻擊者用這兩個狀態碼就能列舉出「哪些訂單 id 有資料」**——
403 = 有這筆、404 = 沒這筆。而訂單 id 通常是連號的。

**看第二列與第四列**（`b404` 版本把 403 也回成 404）：

```
兩種情況都是 404 —— 攻擊者分不出來
```

📌 **完整判準**：

| 情況 | 回什麼 | 理由 |
|---|---|---|
| **資源存在與否本身是機密** | **404** | 訂單、發票、病歷、私人訊息、其他使用者的個人頁 |
| 資源存在是公開事實，只是內容受限 | 403 | 公開文章的編輯頁、公司內部人人都知道的專案 |
| **識別碼不可枚舉**（UUIDv7 等） | 403 也可以 | 猜不到 id，列舉沒有意義；403 對合法使用者友善得多 |
| 需要的是「更高權限」而不是「擁有權」 | 403 | 「這個功能要管理員」——不是資料的問題 |

⚠️ **回 404 有一個實務代價**：

```
使用者：「我明明有這張訂單，為什麼說找不到？」
客服：  「……」
```

**緩解方式**：**回應對外一致，日誌對內分流**——跟 02 章 2.3.6 對登入失敗的處理是同一招。

```java
if (!mine) {
    log.warn("越權存取：user={} 想讀 order={}（擁有者={}）", me.getName(), id, o.getOwnerUsername());
    throw new ResponseStatusException(HttpStatus.NOT_FOUND);     // 對外：找不到
}
```

📌 **這行 `log.warn` 是 08 章稽核的原料**，而且它是**偵測**帳號被盜的最好訊號之一：
一個正常使用者不會在三十秒內「找不到」二十張訂單。

**做法 D 的附帶好處**：它天生就是 404。

```java
return repo.findByIdAndOwnerUsername(id, me.getName())
        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
```

**「不是你的」與「不存在」在查詢層面就已經合而為一了**——
你不需要「記得」要回 404，因為你根本無從分辨。
⚠️ **代價是那行 `log.warn` 也寫不出來了**（你不知道那筆到底存不存在）。
**要稽核的話得多查一次**——這是一個真實的取捨。

### 3.8.5 🔴 實測：列表與分頁

**單筆解決了，列表呢？** `@PostFilter` 看起來是為此而生的（3.5.7）。
**把資料量拉到 10000 筆**（alice 只有 3 筆）：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "res"})
class PagingTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.bulkOrders(jdbc, 10000); }

    @Test
    void postFilterBreaksPaging() {
        System.out.println("""
                
                ═══ 3.8.5 🔴 @PostFilter 遇上分頁 ═══
                ord3 有 10000 筆，alice 只有 3 筆（id = 1, 2, 3）。""");
        Matrix m = new Matrix(port);
        for (int page : new int[]{0, 1, 2}) {
            System.out.println("\n   ── @PostFilter，第 " + page + " 頁（size=20）");
            HttpResponse<String> r = m.send("GET",
                    "/api/res/list/postfilter?page=" + page + "&size=20", "alice");
            System.out.println("      " + r.body());
        }
        for (int page : new int[]{0, 1, 2}) {
            System.out.println("\n   ── @PostFilter（回傳前先 new ArrayList<>(…)），第 " + page + " 頁（size=20）");
            System.out.println("      " + m.send("GET",
                    "/api/res/list/postfilter-mutable?page=" + page + "&size=20", "alice").body());
        }
        System.out.println("\n   ── 查詢條件版，第 0 頁（size=20）");
        System.out.println("      " + m.send("GET", "/api/res/list/scoped?page=0&size=20", "alice").body());

        System.out.println("\n   ── 兩種做法的成本（alice 讀第 0 頁）");
        for (String[] c : new String[][]{
                {"/api/res/list/postfilter?page=0&size=20", "@PostFilter"},
                {"/api/res/list/scoped?page=0&size=20",     "查詢條件"}}) {
            m.send("POST", "/api/res/sql-reset", "alice");
            long t0 = System.nanoTime();
            m.send("GET", c[0], "alice");
            long ms = (System.nanoTime() - t0) / 1_000_000;
            String cnt = m.send("GET", "/api/res/sql-count", "alice").body();
            long loaded = Long.parseLong(cnt.replaceAll(".*\"entitiesLoaded\":(\\d+).*", "$1"));
            System.out.printf("      %-14s 載入 %,6d 個 entity、%,4d ms%n", c[1], loaded, ms);
        }
    }
}
```

```
═══ 3.8.5 🔴 @PostFilter 遇上分頁 ═══
ord3 有 10000 筆，alice 只有 3 筆（id = 1, 2, 3）。

   ── @PostFilter，第 0 頁（size=20）
      [方法內] 資料庫回了 20 筆（total=10000）
      {"status":500,"error":"Internal Server Error","path":"/api/res/list/postfilter"}

   ── @PostFilter，第 1 頁（size=20）
      [方法內] 資料庫回了 20 筆（total=10000）
      {"status":500,"error":"Internal Server Error","path":"/api/res/list/postfilter"}

   ── @PostFilter，第 2 頁（size=20）
      [方法內] 資料庫回了 20 筆（total=10000）
      {"status":500,"error":"Internal Server Error","path":"/api/res/list/postfilter"}
```

🔴 **500。** 伺服器日誌：

```
ERROR o.a.c.c.C.[.[.[/].[dispatcherServlet] : Servlet.service() … threw exception
      [Request processing failed: java.lang.UnsupportedOperationException] with root cause
java.lang.UnsupportedOperationException: null
```

**`@PostFilter` 是【就地修改】那個集合的**（它拿 `Iterator` 出來 `remove()`），
而 `Page.getContent()` 回的是**不可變** list。

**把它複製成可變的 list 之後**：

```
   ── @PostFilter（回傳前先 new ArrayList<>(…)），第 0 頁（size=20）
      [方法內] 資料庫回了 20 筆（total=10000）
      {"page":0,"size":20,"回給前端的筆數":3,"ids":[1,2,3]}

   ── @PostFilter（回傳前先 new ArrayList<>(…)），第 1 頁（size=20）
      [方法內] 資料庫回了 20 筆（total=10000）
      {"page":1,"size":20,"回給前端的筆數":0,"ids":[]}

   ── @PostFilter（回傳前先 new ArrayList<>(…)），第 2 頁（size=20）
      [方法內] 資料庫回了 20 筆（total=10000）
      {"page":2,"size":20,"回給前端的筆數":0,"ids":[]}
```

**不 500 了，但分頁徹底壞掉**：

```
每一頁都是「先取 20 筆，再丟掉不是你的」
   第 0 頁 → 剩 3 筆
   第 1 頁 → 剩 0 筆
   第 2 頁 → 剩 0 筆
使用者看到「第 1 頁有 3 筆，總共 10000 筆，共 500 頁」，翻到第 2 頁一片空白
```

**查詢條件版**：

```
   ── 查詢條件版，第 0 頁（size=20）
      [方法內] 資料庫回了 3 筆（total=3）
      {"page":0,"size":20,"回給前端的筆數":3,"ids":[1,2,3],"totalElements":3,"totalPages":1}
```

✅ **`totalElements=3`、`totalPages=1`——數字全對。**

**成本**：

```
   ── 兩種做法的成本（alice 讀第 0 頁）
      @PostFilter    載入     24 個 entity、  85 ms
      查詢條件           載入      7 個 entity、   79 ms
```

⚠️ **這裡的差距（24 vs 7）看起來不大，因為分頁已經先砍到 20 筆了。**
**真正的災難是「不分頁 + `@PostFilter`」**——3.5.7 那個 `allThenFilter()`
在這張 10000 筆的表上會**把 10000 個 entity 全部載進記憶體**，然後丟掉 9997 個。
3.8.7 會量出那個數字。

📌 **列表端點的三條規則**：

```
🔴 規則一：@PostFilter 【永遠不要】用在會分頁的端點上。
          它只在「集合很小、而且不分頁」時可以用（例如「我的收藏夾」最多 20 筆）。

✅ 規則二：列表的授權條件寫進【查詢】，不要寫進過濾。
          findByOwnerUsername(owner, pageable)

✅ 規則三：如果條件複雜到查詢寫不下，用 Specification / QueryDSL 組條件（08 站 05 章），
          或者 3.8.7 的資料範圍過濾器 —— 一樣是在【資料庫】做，不是在記憶體做。
```

### 3.8.6 實測：寫入端點

**讀的問題解決了，寫呢？** 寫入端點有一個讀沒有的問題：**先查再改，中間有時間差。**

```java
@Transactional
public String cancelReadThenWrite(Long id, Authentication me) {
    Ord3 o = repo.findById(id).orElseThrow(...);          // ① 查
    if (!o.getOwnerUsername().equals(me.getName()))       // ② 比
        throw new AccessDeniedException("不是你的訂單");
    o.setStatus("CANCELLED");                             // ③ 改
    return "已取消 " + id;
}
```

**對照組：把授權條件寫進 `UPDATE` 的 `WHERE`**：

```java
@Modifying(clearAutomatically = true, flushAutomatically = true)
@Query("update Ord3 o set o.status = 'CANCELLED' where o.id = :id and o.ownerUsername = :owner")
int cancelOwned(@Param("id") Long id, @Param("owner") String owner);
```

**兩種做法各打兩次**（自己的 / 別人的），最後直接問資料庫確認真的改了什麼：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "res"})
class WriteEndpointTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    @Test
    void toctou() {
        System.out.println("\n═══ 3.8.6 寫入端點：先查再改 vs 一句 UPDATE ═══");
        Matrix m = new Matrix(port);
        for (String[] c : new String[][]{
                {"/api/res/cancel-rw/1001",     "alice", "自己的"},
                {"/api/res/cancel-rw/1002",     "alice", "bob 的"},
                {"/api/res/cancel-scoped/1003", "bob",   "自己的"},
                {"/api/res/cancel-scoped/1001", "bob",   "alice 的"}}) {
            m.send("POST", "/api/res/sql-reset", "admin");
            HttpResponse<String> r = m.send("POST", c[0], c[1]);
            String cnt = m.send("GET", "/api/res/sql-count", "admin").body();
            long stmts = Long.parseLong(cnt.replaceAll(".*\"statements\":(\\d+).*", "$1"));
            String b = r.body() == null ? "" : r.body().replace("\n", " ");
            if (b.length() > 70) b = b.substring(0, 70) + "…";
            System.out.printf("   %-30s %-6s %-8s → %d  SQL %d 句  %s%n",
                    c[0], c[1], c[2], r.statusCode(), stmts - 1, b);
        }
        // ★ 斷言不能只看狀態碼 —— 3.5.6 證明過狀態碼會騙人
        System.out.println("\n   資料庫現況：");
        jdbc.queryForList("SELECT id, owner_username, status FROM ord3 ORDER BY id")
            .forEach(row -> System.out.println("      " + row));
    }
}
```

```
═══ 3.8.6 寫入端點：先查再改 vs 一句 UPDATE ═══
   /api/res/cancel-rw/1001        alice  自己的      → 200  SQL 3 句  已取消 1001
   /api/res/cancel-rw/1002        alice  bob 的      → 403  SQL 2 句  {"status":403,"error":"Forbidden",…}
   /api/res/cancel-scoped/1003    bob    自己的      → 200  SQL 2 句  已取消 1003（影響 1 列）
   /api/res/cancel-scoped/1001    bob    alice 的    → 404  SQL 2 句  {"status":404,"error":"Not Found",…}

   資料庫現況：
      {id=1001, owner_username=alice, status=CANCELLED}
      {id=1002, owner_username=bob, status=PAID}
      {id=1003, owner_username=bob, status=CANCELLED}
```

✅ **兩種做法的授權結果都正確**（上面的 SQL 句數含 Basic 認證那一句）。
**直接呼叫 Service 量到的乾淨數字**：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.*;
import org.springframework.test.context.ActiveProfiles;

import java.util.function.Supplier;

/**
 * 3.8.6：跟 3.8.3 的 FourWaysSqlTest 同一把尺，只是這次量的是【寫入】。
 * 一樣直接呼叫 Service —— 不走 HTTP，Basic 認證那一句才不會混進來。
 */
@SpringBootTest
@ActiveProfiles({"db", "ch3", "res"})
class WriteSqlTest {

    @Autowired OwnershipService svc;
    @Autowired Sql3 sql;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }
    @AfterEach  void clear() { SecurityContextHolder.clearContext(); }

    static Authentication as(String name, String... authorities) {
        return UsernamePasswordAuthenticationToken.authenticated(
                name, null, AuthorityUtils.createAuthorityList(authorities));
    }

    void login(Authentication a) {
        SecurityContext c = SecurityContextHolder.createEmptyContext();
        c.setAuthentication(a);
        SecurityContextHolder.setContext(c);
    }

    String run(Supplier<Object> call) {
        sql.reset();
        String outcome;
        try { call.get(); outcome = "成功"; }
        catch (Exception e) { outcome = e.getClass().getSimpleName(); }
        return String.format("%-24s SQL %d 句、載入 %d 筆", outcome, sql.statements(), sql.entitiesLoaded());
    }

    @Test
    void writeCost() {
        Authentication alice = as("alice", "ROLE_MEMBER");
        login(alice);
        System.out.println("\n═══ 3.8.6 寫入：先查再改 vs 一句 UPDATE（SQL 句數）═══");
        System.out.printf("   %-35s %s%n", "cancelReadThenWrite(1001) 自己的",
                run(() -> svc.cancelReadThenWrite(1001L, alice)));
        seed();                                   // ★ 上一句真的改了資料，要重灌才量得準
        System.out.printf("   %-35s %s%n", "cancelReadThenWrite(1002) 別人的",
                run(() -> svc.cancelReadThenWrite(1002L, alice)));
        seed();
        System.out.printf("   %-35s %s%n", "cancelScoped(1001) 自己的",
                run(() -> svc.cancelScoped(1001L, alice)));
        seed();
        System.out.printf("   %-35s %s%n", "cancelScoped(1002) 別人的",
                run(() -> svc.cancelScoped(1002L, alice)));
    }
}
```

```
═══ 3.8.6 寫入：先查再改 vs 一句 UPDATE（SQL 句數）═══
   cancelReadThenWrite(1001) 自己的       成功                       SQL 2 句、載入 1 筆
   cancelReadThenWrite(1002) 別人的       AccessDeniedException    SQL 1 句、載入 1 筆
   cancelScoped(1001) 自己的              成功                       SQL 1 句、載入 0 筆
   cancelScoped(1002) 別人的              ResponseStatusException  SQL 1 句、載入 0 筆
```

**差別**：

```
先查再改   成功時 2 句（SELECT + UPDATE）、失敗時載入 1 筆（資料離開了資料庫）
一句 UPDATE 兩種情況都是 1 句、0 筆
```

⚠️ **除了成本，還有一個【正確性】問題：查與改之間的時間差。**

```
時間 →
  T1  alice 的請求：SELECT ord3 WHERE id=1001   → owner = alice ✅
  T2  另一個交易把 1001 的擁有者改成 bob 並 commit
  T3  alice 的請求：UPDATE ord3 SET status='CANCELLED' WHERE id=1001
      🔴 alice 取消了一張【現在屬於 bob】的訂單
```

**這叫 TOCTOU（Time-Of-Check to Time-Of-Use）。**
`@Transactional` 幫不上忙——預設隔離等級 `READ COMMITTED` 允許這件事發生
（07 站 05 章有完整的隔離等級對照）。

📌 **三個修法，成本由低到高**：

```
✅ ① 把授權條件寫進 UPDATE 的 WHERE（本節的 cancelScoped）
      一句 SQL 就是一個原子操作 —— 檢查與修改【不可能】被插隊
      🔴 但它回的是「影響 0 列」，你分不出「不是你的」還是「不存在」（3.8.4 說過這個取捨）

⚠️ ② SELECT ... FOR UPDATE（悲觀鎖，07 站 06 章）
      查的時候就鎖住那一列，代價是併發度

⚠️ ③ 樂觀鎖（@Version，08 站 06 章）
      改的時候檢查版本號，衝突就重試 —— 但「擁有者被改了」這件事版本號未必抓得到
```

⚠️ **「擁有者會不會真的被改掉」聽起來很牽強？**

```
會的場景比你想的多：
  訂單轉移（客服把訂單轉給另一個帳號）
  帳號合併（兩個帳號合併成一個）
  企業客戶的成員異動（員工離職，訂單歸屬部門改變）
  🔴 攻擊者故意製造的競態 —— 他控制其中一個交易的時機
```

📌 **本課的規則**：

> **所有會【寫】資料的端點，授權條件一律寫進 `WHERE`。**
> 這一條同時解決了三件事：SQL 句數、資料外洩面、以及 TOCTOU。

### 3.8.7 實測：資料範圍（Hibernate Filter）

**如果「只看得到自己的」是整個系統的通則**（多租戶 SaaS 最典型），
在每一個查詢方法上加條件會很快失控——**漏掉一個就是一個洞**。

**Hibernate 的 `@Filter` 可以把它變成【資料庫層的預設】**：

```java
@Entity
@Table(name = "ord3")
@FilterDef(name = "ownerScope", parameters = @ParamDef(name = "owner", type = String.class))
@Filter(name = "ownerScope", condition = "owner_username = :owner")
public class Ord3 { ... }
```

```java
/** 開了 filter：同一句 repo.findAll()，SQL 自動多一段 WHERE */
@Transactional(readOnly = true)
public int countAllWithFilter(String owner) {
    em.unwrap(org.hibernate.Session.class)
      .enableFilter("ownerScope")
      .setParameter("owner", owner);
    return repo.findAll().size();
}
```

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest
@ActiveProfiles({"db", "ch3", "res"})
class DataScopeTest {

    @Autowired OwnershipService svc;
    @Autowired Sql3 sql;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.bulkOrders(jdbc, 10000); }

    @Test
    void hibernateFilter() {
        System.out.println("""
                
                ═══ 3.8.7 Hibernate Filter：讓「只看得到自己的」變成預設 ═══
                ord3 有 10000 筆，alice 只有 3 筆。兩次呼叫的【Java 程式碼一模一樣】：repo.findAll()""");
        sql.reset();
        long t0 = System.nanoTime();
        int a = svc.countAllNoFilter();
        long ms1 = (System.nanoTime() - t0) / 1_000_000;
        long loaded1 = sql.entitiesLoaded();

        sql.reset();
        t0 = System.nanoTime();
        int b = svc.countAllWithFilter("alice");
        long ms2 = (System.nanoTime() - t0) / 1_000_000;
        long loaded2 = sql.entitiesLoaded();

        System.out.printf("%n   %-34s 回 %,6d 筆   載入 %,6d 個 entity   %,4d ms%n",
                "沒有 enableFilter", a, loaded1, ms1);
        System.out.printf("   %-34s 回 %,6d 筆   載入 %,6d 個 entity   %,4d ms%n",
                "enableFilter(\"ownerScope\", alice)", b, loaded2, ms2);
    }
}
```

```
═══ 3.8.7 Hibernate Filter：讓「只看得到自己的」變成預設 ═══
ord3 有 10000 筆，alice 只有 3 筆。兩次呼叫的【Java 程式碼一模一樣】：repo.findAll()

   沒有 enableFilter                    回 10,000 筆   載入 10,000 個 entity    111 ms
   enableFilter("ownerScope", alice)  回      3 筆   載入      3 個 entity      3 ms
```

**同一句 `repo.findAll()`，一個回 10000 筆、一個回 3 筆。**
📌 **順帶量出 3.8.5 那個沒說完的數字：不分頁 + `@PostFilter` 會載入 10000 個 entity**，
然後丟掉 9997 個。**這是 3333 倍的無效載入，而且它會隨資料量線性成長。**

⚠️ **那兩個毫秒數在你的機器上會不一樣**（重跑同一個測試，111 ms 也可能變成 50 ms——
JIT 暖機、作業系統快取、連線池狀態都會影響）。
**要看的是【載入幾個 entity】那一欄**——它只跟你寫的程式碼有關，重跑一百次都一樣。

**怎麼「自動」開啟 filter？** 用一個 `OncePerRequestFilter` 或 AOP，在每個請求開頭讀 `SecurityContext`：

```java
package com.example.lab09.ch03;

import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.*;
import org.hibernate.Session;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * 3.8.7：在每一個 @Transactional 的 Service 方法上自動開啟資料範圍。
 * ⚠️ 一定要放在【交易之內】—— filter 是掛在 Hibernate Session 上的，
 *    沒有交易就沒有 Session。
 */
@Aspect
public class DataScopeAspect {

    @PersistenceContext
    private EntityManager em;

    @Around("@within(org.springframework.stereotype.Service) "
          + "&& @annotation(org.springframework.transaction.annotation.Transactional)")
    public Object enableScope(ProceedingJoinPoint pjp) throws Throwable {
        Authentication me = SecurityContextHolder.getContext().getAuthentication();
        boolean staff = me != null && me.getAuthorities().stream()
                .anyMatch(a -> a.getAuthority().equals("order:read:all"));
        if (me != null && !staff) {
            em.unwrap(Session.class).enableFilter("ownerScope").setParameter("owner", me.getName());
        }
        return pjp.proceed();
    }
}
```

⚠️ **這個做法很強大，也很危險。四件事要先想清楚**：

```
🔴 ① 它是【隱形的】。半年後有人寫 repo.findAll() 想做報表，會拿到 3 筆而不是 10000 筆，
     然後花一整天找「為什麼資料不見了」。
     → 一定要在 Entity 的 Javadoc 第一行寫「⚠️ 這張表掛了 ownerScope 過濾器」。

🔴 ② 它只作用在【Hibernate 的查詢】上。JdbcTemplate、原生 SQL、其他服務直連資料庫 —— 全部不受保護。

⚠️ ③ 批次任務 / 排程沒有 SecurityContext，上面那段 aspect 會【不開 filter】= 看得到全部。
     那正好是你要的，但也表示「忘記在某個地方設身分」就等於全開。

⚠️ ④ 一級快取會穿透 filter：同一個 Session 裡先用 em.find(Ord3.class, 1002L) 載入過，
     之後即使開了 filter 也還是拿得到那個物件。
```

📌 **判準**：

```
✅ 適合：多租戶 SaaS（tenant_id 是【每一張表都有】的欄位），漏一個查詢就是跨租戶外洩
⚠️ 不適合：只有一兩張表需要「只看自己的」—— 直接把條件寫進查詢（做法 D）更清楚
```

### 3.8.8 一張決策表

| 你要保護的東西 | 用哪一個 | 節 |
|---|---|---|
| 「這一整區要什麼身分」 | URL 層 `requestMatchers(...).hasAuthority(...)` | 3.3 |
| 「這個動作要什麼權限」 | `@PreAuthorize("hasAuthority('order:refund')")` | 3.5 |
| 「路徑上的識別碼要等於我自己」 | 自訂 `AuthorizationManager` + `ctx.getVariables()` | 3.6.4 |
| 「參數要等於我自己」 | `@PreAuthorize("#owner == authentication.name")` | 3.5.3 |
| **單筆讀取「這筆是不是我的」** | **查詢條件（做法 D）** | 3.8.2 |
| 單筆讀取，規則複雜 | `@PreAuthorize("@guard.canRead(#id, authentication)")` | 3.6.2 |
| **列表 / 分頁** | **查詢條件，永遠不要用 `@PostFilter`** | 3.8.5 |
| **任何會寫資料的操作** | **授權條件寫進 `WHERE`** | 3.8.6 |
| 整個系統都要「只看自己的」 | 資料範圍過濾器 | 3.8.7 |
| 「跑完才知道能不能給」且唯讀 | `@PostAuthorize` | 3.5.6 |

---

## 3.9 測試授權

**授權是這一站唯一「寫錯了不會有任何症狀」的東西。**
認證寫錯，使用者登不進來，你當天就知道；
授權寫太鬆，**一切正常，直到有人發現**。

📌 **所以授權必須有測試，而且測試的形狀是【矩陣】。**

### 3.9.1 實測：`@WithMockUser` 的四種寫法

`spring-security-test` 提供三個註解，直接把身分塞進 `SecurityContext`：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.test.context.support.*;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles({"db", "ch3", "u4"})
@TestMethodOrder(MethodOrderer.MethodName.class)   // ★ JUnit 5 預設【不是】依名稱排序，輸出順序會亂
class WithMockUserTest {

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    static void who(String label) {
        var a = SecurityContextHolder.getContext().getAuthentication();
        System.out.printf("   %-46s → %s  %s%n", label,
                a == null ? "(null)" : a.getName(),
                a == null ? "" : a.getAuthorities());
    }

    @Test @WithMockUser(username = "u1", roles = "ADMIN")
    void a_rolesAdmin() throws Exception {
        System.out.println("\n═══ 3.9.1 @WithMockUser 的四種寫法，各自產生什麼 ═══");
        who("@WithMockUser(roles = \"ADMIN\")");
        System.out.println("      GET /api/admin/revenue → "
                + mvc.perform(get("/api/admin/revenue")).andReturn().getResponse().getStatus());
    }

    @Test @WithMockUser(username = "u2", authorities = "ADMIN")
    void b_authoritiesAdmin() throws Exception {
        who("@WithMockUser(authorities = \"ADMIN\")");
        System.out.println("      GET /api/admin/revenue → "
                + mvc.perform(get("/api/admin/revenue")).andReturn().getResponse().getStatus());
    }

    @Test @WithMockUser(username = "u3", authorities = "ROLE_ADMIN")
    void c_authoritiesRoleAdmin() throws Exception {
        who("@WithMockUser(authorities = \"ROLE_ADMIN\")");
        System.out.println("      GET /api/admin/revenue → "
                + mvc.perform(get("/api/admin/revenue")).andReturn().getResponse().getStatus());
    }

    @Test @WithMockUser
    void d_default() { who("@WithMockUser（什麼都不寫）"); }

    @Test @WithUserDetails("admin")
    void e_withUserDetails() throws Exception {
        who("@WithUserDetails(\"admin\")（真的去查 UserDetailsService）");
        System.out.println("      GET /api/admin/revenue → "
                + mvc.perform(get("/api/admin/revenue")).andReturn().getResponse().getStatus());
    }

    @Test
    void f_rolesWithPrefix() {
        System.out.println("\n═══ 3.9.1 🔴 @WithMockUser(roles = \"ROLE_ADMIN\") ═══");
        try {
            // WithMockUserSecurityContextFactory 是 package-private，用反射把它叫起來
            Class<?> c = Class.forName(
                    "org.springframework.security.test.context.support.WithMockUserSecurityContextFactory");
            var ctor = c.getDeclaredConstructor();
            ctor.setAccessible(true);
            @SuppressWarnings("unchecked")
            WithSecurityContextFactory<WithMockUser> f =
                    (WithSecurityContextFactory<WithMockUser>) ctor.newInstance();
            f.createSecurityContext(AnnotationHolder.class.getDeclaredMethod("holder")
                    .getAnnotation(WithMockUser.class));
            System.out.println("   （沒有拋例外）");
        } catch (java.lang.reflect.InvocationTargetException e) {
            System.out.println("   " + e.getCause().getClass().getSimpleName() + ": " + e.getCause().getMessage());
        } catch (Exception e) {
            System.out.println("   " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    static class AnnotationHolder {
        @WithMockUser(roles = "ROLE_ADMIN")
        static void holder() {}
    }

    @Test
    void g_matrix() throws Exception {
        System.out.println("\n═══ 3.9.2 用 MockMvc 跑一張授權矩陣（不用開真的伺服器）═══");
        String[] endpoints = {"/api/hello", "/api/orders/1001", "/api/admin/revenue", "/api/reports/daily"};
        String[][] users = {{"匿名", ""}, {"alice", "ROLE_USER"}, {"admin", "ROLE_ADMIN"}};
        System.out.printf("%n%-28s %-10s %-10s %-10s%n", "端點", "匿名", "alice", "admin");
        System.out.println("─".repeat(62));
        for (String ep : endpoints) {
            StringBuilder row = new StringBuilder(String.format("%-28s", ep));
            for (String[] u : users) {
                MvcResult r = u[1].isEmpty()
                        ? mvc.perform(get(ep).with(anonymous())).andReturn()
                        : mvc.perform(get(ep).with(user(u[0]).authorities(
                              org.springframework.security.core.authority.AuthorityUtils
                                      .createAuthorityList(u[1])))).andReturn();
                row.append(String.format("%-10d", r.getResponse().getStatus()));
            }
            System.out.println(row);
        }
    }
}
```

```
═══ 3.9.1 @WithMockUser 的四種寫法，各自產生什麼 ═══
   @WithMockUser(roles = "ADMIN")                 → u1  [ROLE_ADMIN]
      GET /api/admin/revenue → 200
   @WithMockUser(authorities = "ADMIN")           → u2  [ADMIN]
      GET /api/admin/revenue → 403
   @WithMockUser(authorities = "ROLE_ADMIN")      → u3  [ROLE_ADMIN]
      GET /api/admin/revenue → 200
   @WithMockUser（什麼都不寫）                           → user  [ROLE_USER]
   @WithUserDetails("admin")（真的去查 UserDetailsService） → admin  [order:refund, ROLE_ADMIN, ROLE_USER]
      GET /api/admin/revenue → 200

═══ 3.9.1 🔴 @WithMockUser(roles = "ROLE_ADMIN") ═══
   IllegalArgumentException: roles cannot start with ROLE_ Got ROLE_ADMIN
```

**四件事**：

```
① roles = "X"        → 產生 ROLE_X          （跟 hasRole 同一套約定）
② authorities = "X"  → 產生 X               （原樣，不加前綴）
③ roles = "ROLE_X"   → 🔴 IllegalArgumentException（跟 URL 層的 hasRole 一樣嚴格，3.4.3）
④ 什麼都不寫          → username=user、authorities=[ROLE_USER]
```

⚠️ **`@WithMockUser` 最大的問題：它跟你的真實帳號【沒有任何關係】。**

```
你的 alice 在資料庫裡是 MEMBER，權限是 order:read
@WithMockUser(roles = "USER") 給的是 ROLE_USER

→ 測試全過，正式環境全掛
```

📌 **`@WithUserDetails("admin")` 才是對的**：它會**真的去呼叫你的 `UserDetailsService`**，
拿到跟正式環境**一模一樣**的 authorities（上面那一列印的是
`[order:refund, ROLE_ADMIN, ROLE_USER]`——完全來自資料庫）。

**兩者的取捨**：

| | `@WithMockUser` | `@WithUserDetails` |
|---|---|---|
| 速度 | 快（不碰資料庫） | 慢（要查資料庫） |
| 真實性 | ❌ 你自己編的 authorities | ✅ 跟正式環境一致 |
| 需要固定裝置嗎 | 不用 | **要**（帳號必須真的存在） |
| 適合 | 測「這條規則對這組 authority 的行為」 | **測「這個帳號能不能做這件事」** |

📌 **本課建議**：

```
授權【規則】的單元測試        → @WithMockUser（我要驗的就是「有 order:refund 的人可以退款」）
授權【矩陣】的整合測試        → @WithUserDetails 或真的送 HTTP（3.1.2 的 Matrix）
                              —— 因為矩陣要驗的是「alice 這個【人】能做什麼」
```

### 3.9.2 實測：一張 MockMvc 授權矩陣

3.1.2 那個 `Matrix` 要開真的伺服器。**跑得快的版本用 `MockMvc`**：

```
═══ 3.9.2 用 MockMvc 跑一張授權矩陣（不用開真的伺服器）═══

端點                           匿名         alice      admin
──────────────────────────────────────────────────────────────
/api/hello                  200       200       200
/api/orders/1001            401       200       200
/api/admin/revenue          401       403       200
/api/reports/daily          401       200       200
```

**`SecurityMockMvcRequestPostProcessors` 的三個常用方法**：

```java
mvc.perform(get(ep).with(anonymous()))                      // 匿名
mvc.perform(get(ep).with(user("alice").roles("USER")))      // 臨時身分
mvc.perform(get(ep).with(user(realUserDetails)))            // 真的 UserDetails
mvc.perform(post(ep).with(csrf()))                          // 帶 CSRF token（04 章）
```

⚠️ **`MockMvc` 預設【不會】套用 Security Filter Chain。**

```java
@SpringBootTest
@AutoConfigureMockMvc          // ★ Boot 會自動加上 springSecurity()
```

**如果你是手動建 `MockMvc`，一定要加**：

```java
mvc = MockMvcBuilders.webAppContextSetup(context)
        .apply(SecurityMockMvcConfigurers.springSecurity())    // ← 少了這行，所有測試都是 200
        .build();
```

📌 **這是「授權測試全綠、正式環境全開」最常見的一個原因。**
**驗證方法：寫一個「匿名打受保護端點應該是 401」的測試。** 它綠了，才代表 chain 真的套上了。

### 3.9.3 資源層要用【同角色的兩個帳號】測

**3.9.2 那張矩陣完全測不到 3.8 的任何一件事。**
因為它的維度是「端點 × **角色**」，而資源層的錯誤是「**同角色的不同人**」。

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import static org.assertj.core.api.Assertions.assertThat;

/** 3.9.3：資源層授權的驗收測試 —— alice 與 bob 是【同一個角色】。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "res"})
class OwnershipMatrixTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); Seed3.orders(jdbc); }

    /** 1001 是 alice 的、1002/1003 是 bob 的 */
    @Test
    void 同角色的兩個帳號互相看不到對方的訂單() {
        Matrix m = new Matrix(port);

        // ① 自己的看得到
        assertThat(m.status("GET", "/api/res/d/1001", "alice")).isEqualTo(200);
        assertThat(m.status("GET", "/api/res/d/1002", "bob")).isEqualTo(200);

        // ② 🔴 別人的看不到 —— 這兩行就是 00 章 0.3.1 的驗收條件
        assertThat(m.status("GET", "/api/res/d/1002", "alice")).isEqualTo(404);
        assertThat(m.status("GET", "/api/res/d/1001", "bob")).isEqualTo(404);

        // ③ 管理員看得到全部
        assertThat(m.status("GET", "/api/res/d/1001", "admin")).isEqualTo(200);
        assertThat(m.status("GET", "/api/res/d/1002", "admin")).isEqualTo(200);

        // ④ 寫入端點同樣要測 —— 而且要驗【資料庫真的沒變】（08 站 06 章的教訓）
        assertThat(m.status("POST", "/api/res/cancel-scoped/1002", "alice")).isEqualTo(404);
        assertThat(jdbc.queryForObject("SELECT status FROM ord3 WHERE id=1002", String.class))
                .isEqualTo("PAID");

        // ⑤ 列表只回自己的
        assertThat(m.send("GET", "/api/res/list/scoped?page=0&size=20", "alice").body())
                .contains("\"ids\":[1001]");
    }
}
```

📌 **第 ④ 點值得強調**：

> **驗「回了 403 / 404」是不夠的，要驗【資料庫真的沒變】。**

3.5.6 就是活生生的例子：`@PostAuthorize` **回了 403，資料庫卻改了**。
一個只斷言狀態碼的測試會**綠燈通過**。

**一份完整的資源層驗收清單**（每一個「屬於某個人的資源」都要跑一遍）：

```
□ 自己的       → 200
□ 別人的       → 404（或 403，看 3.8.4 的判準）
□ 不存在的     → 跟「別人的」【同一個】狀態碼與同一個 body
□ 管理員       → 200
□ 寫入端點     → 除了狀態碼，還要斷言【資料庫沒變】
□ 列表端點     → 只回自己的，而且 totalElements 正確（3.8.5）
```

### 3.9.4 實測：端點 × 規則 覆蓋表

**前面所有測試都有一個共同的盲點：它們只測【你想到要測】的端點。**
新加的端點如果沒人記得加規則、也沒人記得加測試——它就是下一個 0.3.1。

**寫一個掃描器**：把所有 handler method 撈出來，
一支一支問「哪一條 URL 規則會命中它」，並標出「只靠 `anyRequest()` 兜底、又沒有方法層註解」的：

⚠️ **這個類別放在 `src/test/java`，不是 `src/main/java`**——
它用到的 `MockHttpServletRequest` 來自 `spring-test`，那是 `test` scope 的依賴。
放進 `src/main/java` 會直接編譯失敗（`package org.springframework.mock.web does not exist`）。
**它本來就只在測試與 CI 裡跑**（下面那條防線），不需要進正式的成品。

```java
package com.example.lab09.ch03;

import jakarta.annotation.security.DenyAll;
import jakarta.annotation.security.PermitAll;
import jakarta.annotation.security.RolesAllowed;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.access.annotation.Secured;
import org.springframework.security.access.prepost.*;
import org.springframework.security.authorization.AuthorizationManager;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.access.intercept.RequestMatcherDelegatingAuthorizationManager;
import org.springframework.security.web.util.matcher.RequestMatcherEntry;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.condition.RequestMethodsRequestCondition;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.springframework.web.util.ServletRequestPathUtils;

import java.lang.annotation.Annotation;
import java.lang.reflect.Method;
import java.util.*;

/**
 * 3.9.4：把「每一支端點各自被哪一條規則保護」印成一張表。
 * 掉進 anyRequest() 又沒有方法層註解的端點，會被標成 ⚠️ —— 那就是下一個 0.3.1。
 */
public class AuthzCoverageReporter {

    public record Row(String endpoint, String handler, String rule, String annotation, boolean weak) {}

    public static List<Row> scan(RequestMappingHandlerMapping mapping, FilterChainProxy proxy) {
        List<RequestMatcherEntry<? extends AuthorizationManager<?>>> rules = List.of();
        for (SecurityFilterChain chain : proxy.getFilterChains()) {
            for (var f : chain.getFilters())
                if (f instanceof AuthorizationFilter af
                        && af.getAuthorizationManager() instanceof RequestMatcherDelegatingAuthorizationManager d)
                    rules = AuthzRuleReporter.mappings(d);      // ★ 重用 3.2.4 那個反射
        }

        List<Row> rows = new ArrayList<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> e : mapping.getHandlerMethods().entrySet()) {
            RequestMappingInfo info = e.getKey();
            Set<String> patterns = info.getPathPatternsCondition() == null
                    ? Set.of()
                    : info.getPathPatternsCondition().getPatternValues();
            RequestMethodsRequestCondition ms = info.getMethodsCondition();
            String httpMethod = ms.getMethods().isEmpty() ? "GET" : ms.getMethods().iterator().next().name();

            for (String pattern : patterns) {
                // 把 {id} / ** / * 換成一個具體值，才能餵給 matcher
                String probePath = pattern.replaceAll("\\{[^}]+}", "1").replace("/**", "/x").replace("/*", "/x");
                MockHttpServletRequest req = new MockHttpServletRequest(httpMethod, probePath);
                req.setRequestURI(probePath);
                ServletRequestPathUtils.parseAndCache(req);

                String rule = "（沒有命中任何規則 → DENY）";
                boolean any = false;
                for (RequestMatcherEntry<? extends AuthorizationManager<?>> r : rules) {
                    if (r.getRequestMatcher().matches(req)) {
                        rule = AuthzRuleReporter.describe(r.getEntry());
                        any = String.valueOf(r.getRequestMatcher()).contains("any request");
                        break;
                    }
                }
                String ann = annotationOf(e.getValue().getMethod());
                boolean weak = any && ann.isEmpty() && !rule.startsWith("permitAll");
                rows.add(new Row(httpMethod + " " + pattern,
                        e.getValue().getBeanType().getSimpleName() + "." + e.getValue().getMethod().getName(),
                        rule, ann.isEmpty() ? "-" : ann, weak));
            }
        }
        // ⚠️ 只用 endpoint 排序不夠 —— /error 有兩個 handler（error / errorHtml），
        //    順序會每次執行都不一樣。第二個鍵讓輸出穩定下來。
        rows.sort(Comparator.comparing(Row::endpoint).thenComparing(Row::handler));
        return rows;
    }

    static String annotationOf(Method m) {
        List<String> found = new ArrayList<>();
        for (Class<? extends Annotation> t : List.of(PreAuthorize.class, PostAuthorize.class,
                PreFilter.class, PostFilter.class, Secured.class, RolesAllowed.class,
                PermitAll.class, DenyAll.class)) {
            Annotation a = org.springframework.core.annotation.AnnotatedElementUtils.findMergedAnnotation(m, t);
            if (a != null) found.add("@" + t.getSimpleName());
        }
        return String.join(" ", found);
    }

    public static void print(RequestMappingHandlerMapping mapping, FilterChainProxy proxy) {
        List<Row> rows = scan(mapping, proxy);
        System.out.println("\n──────── 端點 × 授權規則 覆蓋表 ────────");
        System.out.printf("%-2s %-34s %-40s %-46s %s%n", "", "端點", "處理方法", "URL 層規則", "方法層註解");
        System.out.println("─".repeat(150));
        for (Row r : rows)
            System.out.printf("%-2s %-34s %-40s %-46s %s%n",
                    r.weak() ? "⚠️" : "", r.endpoint(), r.handler(), r.rule(), r.annotation());
        long weak = rows.stream().filter(Row::weak).count();
        System.out.println("─".repeat(150));
        System.out.println("共 " + rows.size() + " 支端點，其中 " + weak
                + " 支只靠 anyRequest() 兜底、也沒有方法層註解 ⚠️");
    }
}
```

**對著 3.3.7 那份設定（`u4`）跑**：

**把它接成一個測試**（3.3.7 那份寫對的設定）：

```java
package com.example.lab09.ch03;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch3", "u4"})
class CoverageTest {

    @Autowired RequestMappingHandlerMapping mapping;
    @Autowired FilterChainProxy proxy;

    @Test
    void coverage() {
        System.out.println("\n═══ 3.9.4 端點 × 授權規則 覆蓋表（u4 設定）═══");
        AuthzCoverageReporter.print(mapping, proxy);
    }
}
```

```
═══ 3.9.4 端點 × 授權規則 覆蓋表（u4 設定）═══

──────── 端點 × 授權規則 覆蓋表 ────────
   端點                                 處理方法                                     URL 層規則                                        方法層註解
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   DELETE /api/orders/{id}            OrderController.delete                   AuthorityAuthorizationManager[authorities=[ROLE_ADMIN]] -
   GET /api/admin/revenue             AdminController.revenue                  AuthorityAuthorizationManager[authorities=[ROLE_ADMIN]] -
   GET /api/admin/users               Ch03Endpoints.users                      AuthorityAuthorizationManager[authorities=[ROLE_ADMIN]] -
   GET /api/hello                     HelloController.hello                    permitAll()（常數 granted=true）                   -
⚠️ GET /api/me/authorities            Ch03Endpoints.authorities                authenticated() / anonymous() / fullyAuthenticated() -
⚠️ GET /api/orders                    OrderController.list                     authenticated() / anonymous() / fullyAuthenticated() -
⚠️ GET /api/orders/{id}               OrderController.get                      authenticated() / anonymous() / fullyAuthenticated() -
⚠️ GET /api/r/{rule}                  Ch03Endpoints.rule                       authenticated() / anonymous() / fullyAuthenticated() -
⚠️ GET /api/reports/daily             Ch03Endpoints.report                     authenticated() / anonymous() / fullyAuthenticated() -
⚠️ GET /error                         BasicErrorController.error               authenticated() / anonymous() / fullyAuthenticated() -
⚠️ GET /error                         BasicErrorController.errorHtml           authenticated() / anonymous() / fullyAuthenticated() -
⚠️ GET /whoami                        WhoAmIController.me                      authenticated() / anonymous() / fullyAuthenticated() -
   POST /api/admin/users              Ch03Endpoints.createUser                 AuthorityAuthorizationManager[authorities=[ROLE_ADMIN]] -
⚠️ POST /api/echo                     HelloController.echo                     authenticated() / anonymous() / fullyAuthenticated() -
⚠️ POST /api/orders                   Ch03Endpoints.create                     authenticated() / anonymous() / fullyAuthenticated() -
   POST /api/orders/{id}/refund       Ch03Endpoints.refund                     AuthorityAuthorizationManager[authorities=[order:refund]] -
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
共 16 支端點，其中 10 支只靠 anyRequest() 兜底、也沒有方法層註解 ⚠️
```

**這張表回答了三個問題**：

```
① GET /api/orders/{id} 只靠 anyRequest() 兜底 —— 3.8.1 那個洞【在這張表上是看得見的】
② 🔴 GET /error 也被標了 ⚠️ —— 3.3.5 那個「400 變 401」在這裡就能發現
③ 「⚠️ 10 支」是一個【可以放進 CI 的數字】
```

**做成一條防線**：

```java
@Test
void 沒有新的端點掉進 anyRequest 兜底() {
    Set<String> allowed = Set.of(          // ← 明確列出「就是要靠兜底」的端點
            "GET /api/hello", "GET /whoami", "GET /api/me/authorities");
    List<String> weak = AuthzCoverageReporter.scan(mapping, proxy).stream()
            .filter(AuthzCoverageReporter.Row::weak)
            .map(AuthzCoverageReporter.Row::endpoint)
            .filter(e -> !allowed.contains(e))
            .toList();
    assertThat(weak)
        .as("這些端點沒有任何專屬的授權規則，也沒有方法層註解。"
          + "如果那是刻意的，把它加進 allowed 清單並在 code review 裡說明。")
        .isEmpty();
}
```

📌 **這個測試的價值不在「它現在是綠的」，而在「有人加了新端點時它會變紅」**——
而變紅的當下，那個人正在寫那支端點，是**最適合決定授權規則的時機**。

⚠️ **這個掃描器有三個已知的限制**（不要當成唯一的防線）：

```
① 它只看得到 Spring MVC 的 handler —— WebSocket、GraphQL、Actuator 的自訂端點看不到
② 它把 {id} 換成 "1" 去比對 —— 如果你的規則寫了 /api/orders/{id:[a-z]+} 這種正則，結果會不準
③ 它不知道「anyRequest().authenticated() 對這支端點【是不是】足夠」
     —— 那是人的判斷，工具只能把清單交給你
```

---

## 3.10 shop-service 落地

**02 章 2.11 留下的五個「還沒有的東西」，這一章補掉一個半**：

```
🔴 IDOR 還在 —— alice 依然讀得到 bob 的訂單（00 章 0.3.1）        → ✅ 這一章
🔴 API 用 HTTP Basic —— 2.3.5 量過吞吐量上限是 73 個/秒           → 05 章換 JWT
🔴 停用帳號不會立刻踢掉現有 session（2.7.7）                        → 04 章
   （這一章 3.7.7 量到「權限收回來」是同一個問題的另一面）
🔴 登入失敗沒有計數、沒有鎖定                                      → 07 章
🔴 沒有任何稽核紀錄                                               → 08 章
   （這一章 3.2.5 的 AuthorizationDeniedEvent 是它的原料）
```

**① 權限模型：五張表，規則只寫權限**

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
 * shop-service 的 UserDetailsService。
 * 相對於 02 章 2.7.2 那一版，差別只有一個：authorities 從 RBAC 三張表展開（03 章 3.7.4）。
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
                    authorities.add("ROLE_" + rs.getString("role_code"));   // ★ 前綴在這裡加，只加這一次
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

    /**
     * 不可變的快照（02 章 2.7.3 的結論：不要讓 Entity 直接 implements UserDetails）。
     * ★ 多帶一個 userId —— 03 章 3.8 的資源層查詢會用到它，而 getName() 只有帳號字串。
     */
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
    }
}
```

📌 **`userId` 那一欄是這一章加的**，理由在 02 章 2.14 就預告過：
`authentication.getName()` 只有帳號字串，而資源層的查詢條件通常要用 **id**
（帳號可以改名，id 不會）。

**② URL 層：粗篩**

⚠️ **這個類別取代 02 章 2.11 的 `ShopSecurityConfig`**——
兩者的 `apiChain` / `webChain` 是**同名的 bean**，同時留著會
`BeanDefinitionOverrideException`。**加完這一個，把 `ShopSecurityConfig` 刪掉。**
（改名是因為這一章起它管的是授權規則，不再只是「安全設定」。）

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
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableMethodSecurity                     // ★ 03 章 3.5.2：這一行是方法層的開關
public class ShopAuthzConfig {

    /** REST API：無狀態 */
    @Bean
    @Order(1)
    SecurityFilterChain apiChain(HttpSecurity http, AuthenticationManager am) throws Exception {
        return http
            .securityMatcher("/api/**", "/error")
            .authenticationManager(am)                                   // 02 章 2.11
            .authorizeHttpRequests(a -> a
                // ── 公開 ──
                .requestMatchers("/error").permitAll()                   // ★ 3.3.5：少了它，400 會變成 401
                .requestMatchers("/api/auth/login", "/api/auth/register").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
                // ── 規則寫【權限】，不寫角色（3.4.5 / 3.7.2）──
                .requestMatchers(HttpMethod.POST,   "/api/orders/*/refund").hasAuthority("order:refund")
                .requestMatchers(HttpMethod.DELETE, "/api/orders/**").hasAuthority("order:delete")
                .requestMatchers("/api/reports/**").hasAuthority("report:read")
                .requestMatchers("/api/admin/**").hasAuthority("user:manage")
                // ── 兜底：一定是最後一條，而且不是 permitAll（3.3.4 / 3.3.8）──
                .anyRequest().authenticated())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(c -> c.disable())                                      // 00 章 0.5.6 的判準
            .httpBasic(Customizer.withDefaults())                        // ⚠️ 暫時的，05 章換 JWT
            .exceptionHandling(e -> e
                .authenticationEntryPoint(ApiErrors::write401)           // 01 章 1.8.5
                .accessDeniedHandler(ApiErrors::write403))
            .build();
    }

    /** 其餘（後台網頁、Actuator）：有 session、表單登入 */
    @Bean
    @Order(2)                                                            // 01 章 1.7.4：一定要最後
    SecurityFilterChain webChain(HttpSecurity http, AuthenticationManager am) throws Exception {
        return http
            .authenticationManager(am)
            .authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/actuator/**").hasAuthority("user:manage")
                .anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .build();
    }
}
```

**③ 方法層：權限**

```java
@Service
public class OrderService {

    @PreAuthorize("hasAuthority('order:refund')")
    public void refund(Long orderId, BigDecimal amount) { ... }

    @PreAuthorize("hasAuthority('order:read:all')")
    public Page<OrderRow> searchAll(OrderQuery q, Pageable p) { ... }
}
```

**④ 資源層：查詢條件**

```java
package com.example.lab09.shop;

import org.springframework.data.domain.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * 資源層授權：一律走【查詢條件】（03 章 3.8.3 做法 D）。
 * 三個好處：資料不會離開資料庫、列表與分頁自然正確、寫入沒有 TOCTOU。
 */
@Service
public class ShopOrderQueryService {

    private final ShopOrderRepo repo;
    public ShopOrderQueryService(ShopOrderRepo repo) { this.repo = repo; }

    static boolean canSeeAll(Authentication me) {
        return me.getAuthorities().stream()
                .anyMatch(a -> a.getAuthority().equals("order:read:all"));
    }

    static Long userId(Authentication me) {
        return ((ShopUserDetailsService.ShopUserDetails) me.getPrincipal()).userId();
    }

    /** 單筆：不是你的，資料庫就不會回給你 → 天生就是 404（3.8.4） */
    @Transactional(readOnly = true)
    public ShopOrder get(Long id, Authentication me) {
        return (canSeeAll(me) ? repo.findById(id) : repo.findByIdAndOwnerId(id, userId(me)))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    /** 列表：條件寫進查詢，分頁數字才會對（3.8.5） */
    @Transactional(readOnly = true)
    public Page<ShopOrder> list(Authentication me, Pageable pageable) {
        return canSeeAll(me) ? repo.findAll(pageable)
                             : repo.findByOwnerId(userId(me), pageable);
    }

    /** 寫入：授權條件寫進 UPDATE 的 WHERE，沒有 TOCTOU（3.8.6） */
    @Transactional
    public void cancel(Long id, Authentication me) {
        int n = canSeeAll(me) ? repo.cancel(id) : repo.cancelOwned(id, userId(me));
        if (n == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
    }
}
```

**這兩個型別是上面那段用到的**（`ApiErrors` 在 01 章 1.7.6）：

```java
package com.example.lab09.shop;

import jakarta.persistence.*;
import java.math.BigDecimal;

@Entity
@Table(name = "shop_order")
public class ShopOrder {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** ★ 存 userId 而不是帳號字串 —— 帳號可以改名，id 不會 */
    @Column(name = "owner_id", nullable = false)
    private Long ownerId;

    @Column(nullable = false) private BigDecimal amount;
    @Column(nullable = false, length = 16) private String status;

    protected ShopOrder() {}

    public Long getId() { return id; }
    public Long getOwnerId() { return ownerId; }
    public BigDecimal getAmount() { return amount; }
    public String getStatus() { return status; }
}
```

```java
package com.example.lab09.shop;

import org.springframework.data.domain.*;
import org.springframework.data.jpa.repository.*;
import org.springframework.data.repository.query.Param;

import java.util.Optional;

/**
 * 所有「屬於某個人」的查詢都成對出現：
 *   findById / findByIdAndOwnerId、findAll / findByOwnerId、cancel / cancelOwned
 * 讓「有沒有把擁有者帶進去」在 code review 時【一眼看得出來】。
 */
public interface ShopOrderRepo extends JpaRepository<ShopOrder, Long> {

    Optional<ShopOrder> findByIdAndOwnerId(Long id, Long ownerId);

    Page<ShopOrder> findByOwnerId(Long ownerId, Pageable pageable);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update ShopOrder o set o.status = 'CANCELLED' where o.id = :id")
    int cancel(@Param("id") Long id);

    /** ★ 授權條件寫進 WHERE（3.8.6）—— 一句 SQL，沒有 TOCTOU */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update ShopOrder o set o.status = 'CANCELLED' where o.id = :id and o.ownerId = :ownerId")
    int cancelOwned(@Param("id") Long id, @Param("ownerId") Long ownerId);
}
```

**⑤ 三個啟動檢查 + 一個 CI 防線**

```
00 章 0.8.4  SecurityChainReporter   → 每條 chain 上有哪些 Filter
02 章 2.6.3  AuthWiringReporter      → UserDetailsService / PasswordEncoder 各有幾個 bean
03 章 3.2.4  AuthzRuleReporter       → AuthorizationFilter 手上有幾條規則、順序是什麼
03 章 3.9.4  AuthzCoverageReporter   → CI 裡跑，新端點沒規則就變紅
```

**本章結束時，shop-service 的樣子**：

```
權限模型      user_role / app_role / role_permission / permission 四張關聯表
              規則裡【一個角色名稱都沒有】—— 全部是 hasAuthority("...")
URL 層        公開端點列舉、寫入端點指定 HTTP 方法、/error 放行、anyRequest().authenticated() 兜底
方法層        @EnableMethodSecurity + Service 的 public 方法上標 @PreAuthorize
資源層        單筆 / 列表 / 寫入【全部】走查詢條件，principal 上帶 userId
錯誤出口      401 / 403 兩個 handler + 一個「原樣往外丟」的 AccessDeniedException handler（3.5.8）
測試          端點 × 角色矩陣 + alice/bob 同角色的資源層矩陣 + 覆蓋率掃描
```

⚠️ **還沒有的東西**：

```
🔴 權限收回來要等下一次登入（3.7.7）                      → 04 章 / 05 章
🔴 Basic 撐不住流量（02 章 2.3.5）                        → 05 章
🔴 CSRF 直接 disable 了 —— 那是對的，但要說得出理由        → 04 章
🔴 沒有稽核（3.2.5 的事件還沒接到任何地方）                 → 08 章
🔴 多租戶還沒處理（3.8.7 只給了骨架）                       → 視需求
```

---

## 3.11 常見誤區

**誤區 1：「授權規則我寫好了，`hasRole("ADMIN")` 在那裡」**

→ 3.3.2 實測：規則寫在 `/api/**` 後面，那一行**一次都沒有被評估過**，
而且**啟動不報錯、沒有任何警告**。
**用 3.2.4 的規則表確認【真實順序】**，不要相信程式碼讀起來的樣子。

---

**誤區 2：「`requestMatchers("/api/admin/**")` 就是保護了整個後台」**

→ 3.3.4 實測：那條規則只寫了 `GET`，**匿名的 `POST /api/admin/users` 回 200**。
授權矩陣的「請求」欄一律寫成**方法 + 路徑**。

---

**誤區 3：「沒寫到的路徑會自動被擋，所以不用寫 `anyRequest()`」**

→ 3.3.8 實測：**確實會被擋**（fail-closed）。
但讀你設定的人**分不出「刻意」與「忘了」**。
一律明確寫出最後一條，而且**不能是 `permitAll()`**（3.3.4）。

---

**誤區 4：「我看到一堆 401，應該是有人在猜密碼」**

→ 3.3.5 實測：`StrictHttpFirewall` 擋掉的路徑攻擊（`;`、`//`、`..`）**回的是 400**，
但如果 `/error` 沒有 `permitAll`，那個 400 會被 ERROR dispatch **蓋成 401**。
**先確認 `/error` 有規則，再去解讀 401 的數量。**

---

**誤區 5：「`hasRole("ROLE_ADMIN")` 比較清楚，寫全一點」**

→ 3.4.3 實測：URL 層**啟動就失敗**、方法層**完全正常**。
同一句話兩種待遇，而且讓你的規則**在兩層之間搬不動**。
**`hasRole` 的參數永遠不帶前綴。**

---

**誤區 6：「`hasAuthority("ADMIN")` 跟 `hasRole("ADMIN")` 應該差不多」**

→ 3.4.2 實測：`hasAuthority("ADMIN")` 找的是字串 `ADMIN`，
而資料庫裡是 `ROLE_ADMIN`——**admin 自己也進不去**。
`hasRole(X)` 就是 `hasAuthority("ROLE_" + X)`，**沒有別的魔法**。

---

**誤區 7：「`@PreAuthorize` 我加了，所以那個方法安全了」**

→ 三個原因會讓它**完全不生效，而且沒有任何警告**：
忘了 `@EnableMethodSecurity`（3.5.2，**整個服務一起失效**）、
被同類別直接呼叫（3.5.5）、標在 `private` 方法上（3.5.5）。
**一定要有一個「這個註解真的會擋人」的測試。**

---

**誤區 8：「`@PostAuthorize` 擋下來了，所以那個操作沒有發生」**

→ 3.5.6 實測：HTTP 回 403，**資料庫裡那筆 UPDATE 已經 commit 了**。
因為 `TransactionInterceptor` 的 order 是 `Integer.MAX_VALUE`——**交易在最裡層**。
**`@PostAuthorize` 只用在唯讀方法上。**

---

**誤區 9：「`@PostFilter` 一行就解決了『只看得到自己的』」**

→ 3.8.5 實測：遇上 `Page.getContent()` 直接 **500**（`UnsupportedOperationException`）；
複製成可變 list 之後**分頁徹底壞掉**（第 0 頁 3 筆、第 1 頁 0 筆、`total` 還是 10000）；
不分頁的話會**把 10000 個 entity 全部載進記憶體再丟掉 9997 個**（3.8.7）。
**列表的授權條件寫進查詢，不要寫進過濾。**

---

**誤區 10：「查出來再比對，跟寫進查詢條件，效果一樣」**

→ 3.8.3 實測：被拒絕時，前者**載入 1 筆**（資料進了 JVM 記憶體）、後者**載入 0 筆**。
寫入端點還多一個 TOCTOU（3.8.6）。
**會寫資料的操作，授權條件一律寫進 `WHERE`。**

---

**誤區 11：「回 403 比 404 誠實」**

→ 3.8.4：403 與 404 的差別，等於送給攻擊者一份「哪些 id 有資料」的地圖。
**資源存在與否本身是機密時回 404**，並且把真正的原因寫進日誌（那也是偵測帳號被盜的訊號）。

---

**誤區 12：「我宣告了 `RoleHierarchy` bean，管理員自動有所有權限了」**

→ 3.7.5 實測：**URL 層吃到了、方法層沒有**。
同一句 `hasRole('MEMBER')`，URL 層讓 admin 過、`@PreAuthorize` 擋下來。
**方法層要自己接 `DefaultMethodSecurityExpressionHandler`（而且要 `static`）。**

---

**誤區 13：「我把那個人的權限從資料庫刪掉了，他就進不去了」**

→ 3.7.7 實測：**同一個 session 照樣 200**。
`authorities` 是**認證那一刻**的快照。
Session 要等下次登入、JWT 要等 token 過期。**高風險動作要即時查一次。**

---

**誤區 14：「`@ExceptionHandler(Exception.class)` 讓錯誤格式統一了」**

→ 3.5.8 實測：它把方法層的 **403 變成 500**，
而 URL 層的 403 完全不受影響（它根本不進 `DispatcherServlet`）。
**明確接住 `AccessDeniedException` 並原樣往外丟。**

---

**誤區 15：「授權測試都綠的」**

→ 三個常見的假綠燈：
`MockMvc` 沒套 `springSecurity()`（3.9.2，**全部 200**）、
用 `@WithMockUser` 自己編 authorities（3.9.1，跟正式環境無關）、
只斷言狀態碼不斷言資料庫（3.9.3，`@PostAuthorize` 那個坑）。
**再加一條：矩陣裡沒有 alice / bob 這種【同角色兩個帳號】，資源層等於沒測。**

---

## 3.12 本章小結

**一、授權有三層，每一層看得到的東西不一樣（3.2.1）。**

```
URL 層    看得到：方法、路徑、標頭、身分           擋不掉：「這一筆不是你的」
方法層    多看得到：參數、回傳值                   代價：AOP 的三個陷阱（3.5.2、3.5.5）
資源層    必須碰資料                              ★ 唯一能修掉 IDOR 的一層
```

**二、URL 層是一條【有順序的 list】，第一個命中就決定（3.3）。**

```
規則寫反 → 靜默失效（3.3.2）—— 只有 3.2.4 那份規則表看得出來
忘了寫 HTTP 方法 → 匿名 POST 拿到 200（3.3.4）
anyRequest().permitAll() → 把「忘了寫規則」變成「公開端點」
/error 沒有 permitAll → 防火牆的 400 被蓋成 401（3.3.5）
```

**三、`ROLE_` 那四個字，兩層的待遇不一樣（3.4）。**

```
hasRole(X) 就是 hasAuthority("ROLE_" + X)
hasRole("ROLE_ADMIN")   URL 層：啟動失敗    方法層：正常運作
🔴 規則裡寫【權限】不要寫角色 —— 角色屬於資料表，不屬於程式碼
```

**四、方法層授權有三種「完全不生效」的失效方式，全部沒有警告（3.5）。**

```
忘了 @EnableMethodSecurity   → 整個服務一起失效
自我呼叫 this.method()        → 一個方法悄悄失效
標在 private 方法上           → 同上
```

**五、`@PostAuthorize` 有三個代價，第二個會出事（3.5.6）。**

```
① 資料已經離開資料庫（3.8.3 量到「載入 1 筆」）
🔴 ② 交易【已經 commit】—— TransactionInterceptor 的 order 是 MAX，它在最裡層
③ SpEL 沒處理 returnObject == null → 查無資料變成 500
```

**六、資源層是本章的重點，而它的答案很單純（3.8）。**

```
✅ 把授權條件寫進【查詢】
   單筆    findByIdAndOwnerId(id, me)        → 被拒時載入 0 筆、天生 404
   列表    findByOwnerId(me, pageable)       → 分頁數字正確
   寫入    UPDATE … WHERE id = ? AND owner = ?  → 一句 SQL，沒有 TOCTOU

🔴 不要用 @PostFilter 做列表（500、分頁壞掉、10000 筆載進記憶體）
🔴 不要用 @PostAuthorize 做寫入（交易已經 commit）
```

**七、授權必須有測試，而且形狀是矩陣（3.9）。**

```
端點 × 角色         → 3.9.2 的 MockMvc 矩陣
同角色的兩個帳號     → 3.9.3 —— 這是資源層【唯一】測得出來的方式
端點 × 規則 覆蓋率   → 3.9.4 —— 讓「新端點忘了加規則」在 CI 就變紅
斷言要包含【資料庫沒變】—— 只看狀態碼會被 3.5.6 騙過去
```

### 3.12.1 驗收清單

```
□ 授權的三層各自看得到什麼？各自看不到什麼？
□ AuthorizationManager.check() 回 null 會發生什麼事？跟回 false 差在哪？
□ 一個 403 的請求，AuthorizationFilter 跑了幾次？為什麼？
□ AuthorizationGrantedEvent 預設會不會發？為什麼？
□ authorizeHttpRequests 的規則是怎麼被評估的？兩條規則會不會「都要滿足」？
□ 順序寫反的兩種結局分別是什麼？Spring 為什麼只擋得住一種？
□ 「規則只寫了 GET」會造成什麼？為什麼一般測試抓不到？
□ StrictHttpFirewall 擋掉哪四種路徑？為什麼你看到的是 401 而不是 400？
□ permitAll / denyAll / anonymous / authenticated / fullyAuthenticated 的差別？
□ denyAll() 對匿名與對登入者，狀態碼為什麼不同？
□ 不寫 anyRequest() 會怎樣？為什麼還是要寫？
□ hasRole(X) 實際上做了什麼？哪一行？
□ hasRole("ROLE_ADMIN") 在 URL 層與方法層的行為為什麼不同？
□ GrantedAuthorityDefaults 為什麼一定要 static？
□ 什麼時候用 hasRole、什麼時候用 hasAuthority？
□ @EnableMethodSecurity 預設打開哪幾個註解？沒打開的是哪兩個？
□ @Secured("ADMIN") 與 @RolesAllowed("ADMIN") 的差別？
□ 方法層授權「完全不生效」的三個原因？
□ @PostAuthorize 的三個代價？為什麼交易不會回滾？
□ AuthorizationInterceptorsOrder 的六個值？TransactionInterceptor 的 order 是多少？
□ @PreFilter 把不合規則的參數剃掉之後，狀態碼是什麼？這為什麼危險？
□ 方法層的 AccessDeniedException 與 URL 層的，走的是哪兩條路？
□ 一個 @ExceptionHandler(Exception.class) 會造成什麼？怎麼修？
□ 註解寫在介面上會不會生效？實作也標一個不同的呢？什麼時候爆？
□ 角色與權限的分界線在哪？為什麼規則裡要寫權限？
□ RBAC 的五張表？前綴為什麼不存進資料庫？
□ RoleHierarchy 在 URL 層與方法層的差別？怎麼修？
□ 權限從資料庫刪掉之後，session / JWT 各要多久才生效？
□ 資源層四種做法的 SQL 句數與「載入幾筆」分別是多少？
□ 什麼時候回 403、什麼時候回 404？
□ @PostFilter 遇上 Page.getContent() 會怎樣？為什麼？
□ 「先查再改」的 TOCTOU 是什麼？三個修法的代價？
□ Hibernate Filter 的四個風險？
□ @WithMockUser(roles=…) 與 (authorities=…) 差在哪？roles="ROLE_X" 會怎樣？
□ 為什麼資源層授權一定要用同角色的兩個帳號測？
□ 授權測試「假綠燈」的三個原因？
```

### 3.12.2 本章練習

**練習一（動手）：把 3.2.4 的規則表印出來，然後找一條錯的**

1. 把 `AuthzRuleReporter` 放進你自己的專案（它只依賴 `FilterChainProxy`）。
2. 對照那份輸出與你的 `SecurityConfig`，確認**順序一致**。
3. 找出「被前面某條規則蓋掉」的規則——如果有，它已經死了多久？
4. 回答：如果你的專案有兩條 chain，兩份規則表分別長什麼樣？

**練習二（動手）：用矩陣找出你專案裡的洞**

1. 把 3.1.2 的 `Matrix` 搬過去，列出你**所有**的寫入端點（POST / PUT / PATCH / DELETE）。
2. 帳號欄至少要有：匿名、一般使用者、**同角色的第二個使用者**、管理員。
3. 跑一次，把每一格「不是你預期」的標出來。
4. 回答：有幾格是「匿名拿到 2xx」？有幾格是「使用者 A 動到使用者 B 的資料」？

**練習三（動手）：重現 3.5.6 的「403 但資料改了」**

1. 在你的專案找一個 `@Transactional` 的寫入方法，加上 `@PostAuthorize("hasRole('ADMIN')")`。
2. 用非管理員呼叫，確認回 403。
3. **去資料庫看那一筆**。
4. 用 `AdvisorReporter` 印出那個 bean 的代理鏈，找出 `TransactionInterceptor` 的位置。
5. 改成 `@PreAuthorize`，再跑一次。

**練習四（動手）：把一個列表端點從 `@PostFilter` 改成查詢條件**

1. 找一個（或自己寫一個）用 `@PostFilter` 過濾的列表端點。
2. 把資料量灌到 10000 筆，量「載入幾個 entity、幾毫秒」。
3. 改成 `findByOwner...(owner, pageable)`，再量一次。
4. 回答：`totalElements` 在改之前與改之後分別是多少？前端會怎麼顯示？

**練習五（動手）：把角色從程式碼裡拿掉**

1. `grep -rn 'hasRole\|hasAnyRole' src/main` 列出所有寫死角色的地方。
2. 為每一個設計一個權限名稱（3.7.6 的慣例）。
3. 建 RBAC 三張表，把角色 → 權限的對應塞進去。
4. 把規則一條一條換成 `hasAuthority`，每換一條就跑一次矩陣。
5. 回答：換完之後，「客服也要能退款」這個需求要改幾個檔案？

**練習六（動手）：把 3.9.4 的覆蓋率掃描放進 CI**

1. 把 `AuthzCoverageReporter` 加進你的測試。
2. 跑一次，看有幾支端點被標 ⚠️。
3. 逐一判斷：哪些是「刻意靠兜底」的？把它們列進 `allowed`。
4. 剩下的補上規則，直到測試變綠。
5. 新增一支端點但**不加規則**，確認測試**變紅**。

**練習七（讀原始碼）：`AuthorizationFilter` 到 `AuthorityAuthorizationManager`**

打開 `org.springframework.security.web.access.intercept.AuthorizationFilter`。

- `doFilter` 裡為什麼身分是 `Supplier<Authentication>` 而不是 `Authentication`？
  （提示：`permitAll` 的規則會不會呼叫那個 supplier？）
- 找到 `RequestMatcherDelegatingAuthorizationManager.check`，
  確認「沒有命中任何規則」時它回什麼。
- 再打開 `AuthorityAuthorizationManager`，看 `hasRole` 的那個 `Assert.isTrue`——
  為什麼 SpEL 那一邊（`SecurityExpressionRoot.getRoleWithDefaultPrefix`）不這樣做？

**練習八（思考題）：一個真實需求的三層拆解**

需求：「業務主管可以看**自己底下所有業務**的訂單，但只能改**自己**的。」

- 這條規則要拆成幾層？每一層各負責哪一部分？
- 「自己底下所有業務」這個集合要在哪裡算出來？認證時？每次請求時？
- 如果一個業務今天換了主管，舊主管的 session 還看得到他嗎？（提示：3.7.7）
- 如果組織有五層，你會用 `RoleHierarchy` 嗎？為什麼？（提示：3.7.5 最後那段）

---

## 3.13 下一章預告

**04 章：Session 與無狀態、CSRF。**

這一章有兩個問題**故意沒有回答**：

**① `csrf(c -> c.disable())` 這一行，到現在出現了十幾次，理由只給過一句話。**

00 章 0.5.6 量過「CSRF 預設是開的」，
這一章每一條 chain 都把它關掉——**因為它們都是無狀態的 API**。
但「無狀態就可以關 CSRF」這句話**只在特定條件下成立**，04 章會把條件講清楚，
並且用實測示範**條件不成立時會發生什麼**。

**② 3.7.7 那個「權限收回來，同一個 session 照樣 200」。**

那不是授權的問題，是**身分載體**的問題。
04 章會把 session 的機制整個攤開：它存在哪裡、什麼時候被建立、
`session fixation` 防護做了什麼、以及**怎麼把一個還活著的 session 作廢**。

**這一章留下的三個線索，04 章會用到**：

| 這一章的東西 | 04 章要用它做什麼 |
|---|---|
| 3.3.6 的 `fullyAuthenticated()` | remember-me 為什麼拿到 401 而不是 403——那是 session 與「憑證新鮮度」的分界 |
| 3.7.7 的「權限快照」 | 有狀態 vs 無狀態的核心取捨：**快取身分省下的每一句 SQL，都是一段「資料過期」的時間** |
| 3.2.5 的 `AuthorizationDeniedEvent` | 04 章會加上 session 事件，08 章把兩者合成稽核日誌 |

**還有四個 04 章要處理的問題**：

```
① Session 到底存了什麼？為什麼「無狀態」的 API 有時候還是長出了 JSESSIONID
② CSRF 攻擊的完整流程 —— 以及為什麼「檢查 Referer」不夠
③ SameSite cookie 出現之後，CSRF token 還需要嗎
④ 前後端分離 + cookie 認證，CSRF token 要怎麼給前端
```

📌 **04 章結束時，你會有一張「什麼情況可以關 CSRF」的判準表**——
而不是「別人的專案都關了所以我也關」。

⚠️ **順帶預告一個 04 章的實測**：
`sessionCreationPolicy(STATELESS)` **不會**阻止 session 被建立——
它只是叫 Spring Security 不要用 session 存 `SecurityContext`。
**你的 Controller 只要碰一次 `HttpSession`，session 照樣會生出來**，
而那在自動擴展的環境下會變成一個很難查的 bug。
