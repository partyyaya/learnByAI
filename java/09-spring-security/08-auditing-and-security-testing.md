# 第 08 章：稽核與安全測試

> 前七章做了很多「擋下來」的事。這一章問兩個問題：
>
> ```
> ① 擋下來之後，有沒有人知道？        —— 稽核（8.2～8.4）
> ② 下次有人改壞了，有沒有東西會叫？    —— 測試（8.5～8.7）
> ```
>
> 這兩件事都有一個共同的性質：**做了沒有立即的好處，不做也不會馬上出事。**
> 所以它們永遠排在待辦清單的最後面，直到——
>
> ```
> 「上禮拜有客戶反應資料被改了，是誰改的？」        → 沒有紀錄，查不到
> 「這個端點什麼時候變成不用登入的？」               → git blame 出來是三個月前，沒有人記得
> 「我們的權限設定有沒有被改壞過？」                 → 沒有人知道，因為沒有東西在看
> ```
>
> 📌 **這一章有十八個實測。** 其中六個值得先劇透：
>
> ```
> 8.2.2  🔴 無狀態 API 下，「登入成功事件」跟請求數一起長 —— 20 個請求 = 20 次「登入」
> 8.2.3  🔴 授權失敗事件：URL 層【預設就發】、方法層【預設不發】—— 而你最該記的都在方法層
> 8.3.4  🔴 業務失敗回滾，把那筆「記錄失敗」的稽核也一起回滾掉了
> 8.3.5  🔴 登入失敗事件裡，有使用者剛剛打的【明碼密碼】
> 8.5.1  🔴 MockMvc 預設沒有掛上 Security —— 你的授權測試【全部是綠的，也全部沒測到】
> 8.5.3  🔴 `@WithMockUser(authorities = "ADMIN")` 對不上 `hasRole("ADMIN")`，而且只回 403 不報錯
> ```
>
> ⚠️ **這一章有一個貫穿全章的判準**：
>
> > **稽核與測試的價值，不在「現在是對的」，在「變成錯的時候會有人知道」。**
> > 所以每寫一條，都要問：**它什麼時候會叫？如果永遠不會叫，那它在保護什麼？**

---

## 8.1 學習目標與實驗環境

完成本章後，你應該可以：

- 說出 Spring Security 發出哪些事件、哪些**預設就有**、哪些要自己打開（8.2）。
- 解釋為什麼「監聽 `AuthenticationSuccessEvent` 當登入紀錄」在無狀態 API 上是錯的（8.2.2）。
- 說出 URL 層與方法層的授權事件**預設值不一樣**，以及怎麼補（8.2.3）。
- 設計一張稽核表，說出六個必要欄位各自回答什麼問題（8.3.1、8.3.3）。
- 解釋為什麼稽核寫入要用 `REQUIRES_NEW`，以及不用會發生什麼（8.3.4）。
- 說出稽核程式最容易寫出來的資安漏洞（8.3.5）。
- 用 `@CreatedBy` / `AuditorAware` 自動填「誰做的」，並說出它在背景執行緒上為什麼失效（8.4）。
- 正確地把 `MockMvc` 接上 Security，並寫一個「哨兵測試」證明它真的接上了（8.5.1、8.5.2）。
- 說出 `@WithMockUser` 的三個坑，以及 `@WithUserDetails` / 自訂註解各解掉哪一個（8.5.3～8.5.7）。
- 寫一張授權矩陣測試，並說明為什麼「匿名」那一欄不能省（8.6.1）。
- 說出哪些事情**只能**用真的登入來測（8.7）。
- 照著一份檢查清單，把 00～07 章的每一個 🔴 逐一驗過（8.8）。

### 8.1.1 本章的實驗環境

| 項目 | 版本 |
|---|---|
| Spring Boot | 3.2.5 |
| Spring Security | 6.2.4 |
| `spring-security-test` | 6.2.4（`spring-boot-starter-test` 之外的另一個相依） |
| JDK | Temurin 21.0.5 |
| MySQL | 8.0.46 |
| 機器 | Apple M2 / macOS 14.2.1 |

**① 相依**（00 章 0.8.1 就加過了，這裡確認一次）：

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-test</artifactId>
  <scope>test</scope>
</dependency>
<!-- ★ 這一個要【另外】加 —— @WithMockUser / SecurityMockMvcRequestPostProcessors 都在裡面 -->
<dependency>
  <groupId>org.springframework.security</groupId>
  <artifactId>spring-security-test</artifactId>
  <scope>test</scope>
</dependency>
```

**② 兩張新表**：

```sql
-- 稽核紀錄（8.3）
CREATE TABLE audit_log (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  at            DATETIME(3)  NOT NULL,          -- when（毫秒；存 UTC）
  actor         VARCHAR(64)  NULL,              -- who（帳號名）
  actor_id      BIGINT       NULL,              -- who（★ id 也要：帳號會改名）
  action        VARCHAR(64)  NOT NULL,          -- what（動詞常數，不是自由字串）
  target_type   VARCHAR(64)  NULL,              -- on what（分兩欄，之後才查得動）
  target_id     VARCHAR(64)  NULL,
  outcome       VARCHAR(16)  NOT NULL,          -- SUCCESS / DENIED / FAILURE
  reason        VARCHAR(128) NULL,              -- 失敗時的分類（★ 不放例外訊息全文，7.6.1）
  client_ip     VARCHAR(45)  NULL,              -- IPv6 也放得下
  user_agent    VARCHAR(255) NULL,
  trace_id      VARCHAR(64)  NULL,              -- 串回 log（7.6.1 的那個編號）
  KEY idx_at (at),
  KEY idx_actor (actor, at),                    -- 「這個人做了什麼」
  KEY idx_action (action, at)                   -- 「最近有誰登入失敗」
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8.4 的 JPA Auditing 示範用
CREATE TABLE note (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner_username VARCHAR(64) NOT NULL,          -- 業務欄位：這筆【屬於】誰（授權用）
  body           VARCHAR(255) NOT NULL,
  created_by     VARCHAR(64)  NULL,             -- 稽核欄位：這筆【是誰寫的】
  created_at     DATETIME(3)  NULL,
  updated_by     VARCHAR(64)  NULL,
  updated_at     DATETIME(3)  NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**③ 三支觀察端點**（路徑前綴用 `/a`，跟前面各章分開——04 章用的是 `/s`）：

```java
package com.example.lab09.ch08;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/** 08 章的端點：一支公開、一支要登入、一支要 ADMIN，外加兩支觀察 principal 的。 */
@RestController
@Profile("a1 | a2 | a3 | a4 | au | ac")
public class Ch08Endpoints {

    private final Ch08Service service;
    private final ObjectProvider<NoteWriter> writer;      // 8.4 才有的 bean（profile au）
    public Ch08Endpoints(Ch08Service service, ObjectProvider<NoteWriter> writer) {
        this.service = service; this.writer = writer;
    }

    @GetMapping("/a/public/ping")
    public Map<String, Object> ping() { return Map.of("pong", true); }

    @GetMapping("/a/me")
    public Map<String, Object> me(Authentication auth) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", auth == null ? null : auth.getName());
        m.put("authorities", auth == null ? List.of() : auth.getAuthorities().toString());
        return m;
    }

    @GetMapping("/a/admin/users")
    public Map<String, Object> users() { return Map.of("users", List.of("alice", "bob", "admin")); }

    /** 8.5 觀察用：目前的 principal 到底是什麼型別 */
    @GetMapping("/a/principal")
    public Map<String, Object> principal(Authentication auth) {
        Object p = auth == null ? null : auth.getPrincipal();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("principalClass", p == null ? "null" : p.getClass().getName());
        m.put("name", auth == null ? null : auth.getName());
        m.put("authorities", auth == null ? List.of() : auth.getAuthorities().toString());
        return m;
    }

    /**
     * 8.5.3：一支用 `@AuthenticationPrincipal` 取【你自己的 principal 型別】的端點。
     * 這是 04 章 4.8 之後最常見的寫法 —— 也是 `@WithMockUser` 的第二個坑。
     */
    @GetMapping("/a/display-name")
    public Map<String, Object> displayName(@AuthenticationPrincipal AppPrincipal principal) {
        return Map.of("displayName", principal.displayName());      // principal 是 null 就 NPE
    }

    /** ★ 這一支【沒有】URL 層的規則保護 —— 擋它的是 service 上的 @PreAuthorize（8.2.3） */
    @PostMapping("/a/orders/{id}/refund")
    public Map<String, Object> refund(@PathVariable long id) {
        return Map.of("refunded", service.refund(id));
    }

    /** 8.4：在【請求的執行緒】上寫一筆 note */
    @PostMapping("/a/notes")
    public Map<String, Object> createNote(@RequestParam String body) {
        Note n = writer.getObject().writeHere("alice", body);
        return Map.of("id", n.getId(), "createdBy", String.valueOf(n.getCreatedBy()));
    }

    /** 🔴 8.4.2：丟到 @Async 的執行緒上寫同一筆 */
    @PostMapping("/a/notes/async")
    public Map<String, Object> createNoteAsync(@RequestParam String body) throws Exception {
        long id = writer.getObject().writeAsync("alice", body).get();
        return Map.of("id", id, "createdBy", String.valueOf(writer.getObject().find(id).getCreatedBy()));
    }
}
```

```java
package com.example.lab09.ch08;

import org.springframework.context.annotation.Profile;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Service;

/** 一支只有【方法層】保護的服務 —— 8.2.3 用它對照 URL 層與方法層的事件差異。 */
@Service
@Profile("a1 | a2 | a3 | a4 | au | ac")
public class Ch08Service {

    @PreAuthorize("hasAuthority('order:refund')")
    public long refund(long orderId) { return orderId; }
}
```

**④ 你自己的 principal 型別**（延續 04 章 4.8 的 `ShopUserDetails`）：

```java
package com.example.lab09.ch08;

import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import java.util.*;

/**
 * 你自己的 principal 型別：多帶 userId 與 displayName，`equals` 只比 `userId`（04 章 4.3.2）。
 * 8.5 用它示範 `@AuthenticationPrincipal` 的型別問題。
 */
public record AppPrincipal(Long userId, String username, String displayName,
                           String password, Collection<? extends GrantedAuthority> authorities)
        implements UserDetails {

    public static AppPrincipal of(long userId, String username, String displayName, String... authorities) {
        return new AppPrincipal(userId, username, displayName, "{noop}n/a",
                Arrays.stream(authorities).map(a -> (GrantedAuthority) new SimpleGrantedAuthority(a)).toList());
    }

    @Override public Collection<? extends GrantedAuthority> getAuthorities() { return authorities; }
    @Override public String getPassword() { return password; }
    @Override public String getUsername() { return username; }
    @Override public boolean isAccountNonExpired() { return true; }
    @Override public boolean isAccountNonLocked() { return true; }
    @Override public boolean isCredentialsNonExpired() { return true; }
    @Override public boolean isEnabled() { return true; }

    /** 04 章 4.3.2：SessionRegistry 拿 principal 當 Map 的 key，只比 userId 才穩 */
    @Override public boolean equals(Object o) {
        return o instanceof AppPrincipal p && Objects.equals(userId, p.userId);
    }
    @Override public int hashCode() { return Objects.hash(userId); }
}
```

**⑤ profile 對照**：

```
a1   Basic ＋ STATELESS          —— 8.2.2 量「每個請求都發一次成功事件」
a2   表單登入 ＋ session           —— 8.2.1 看一輪完整操作的事件
a3   a2 ＋ AuthorizationEventPublisher bean   —— 8.2.3
a4   a3 ＋ 連 GRANTED 也發         —— 8.2.4
au   完整稽核情境（AuditListener ＋ JPA Auditing）—— 8.3、8.4、8.6
ac   跟 au 一樣但【CSRF 開著】      —— 8.5.6 的 `csrf()` post-processor
```

### 8.1.2 先把「稽核」與「log」分開

這兩件事長得像，但目的完全不同，混在一起是很多系統的問題根源：

```
┌──────────┬──────────────────────────────┬──────────────────────────────┐
│          │ 應用程式 log                    │ 稽核紀錄（audit log）           │
├──────────┼──────────────────────────────┼──────────────────────────────┤
│ 給誰看     │ 工程師                         │ 稽核人員、資安、法遵、客服          │
│ 目的       │ 除錯：「為什麼會 500」            │ 追責：「是誰在什麼時候做了什麼」      │
│ 內容       │ 堆疊、參數、中間狀態              │ 結構化的六個欄位（8.3.3）         │
│ 保留       │ 幾天～幾週                      │ 幾個月～七年（法遵決定）            │
│ 可否遺失    │ 可以（掉幾行沒關係）              │ 🔴 不可以 —— 掉一筆就是查不到       │
│ 可否修改    │ 沒差                          │ 🔴 不可以 —— 要 append-only      │
│ 格式       │ 人看的文字                      │ 機器查的欄位（要能 WHERE、能 JOIN） │
└──────────┴──────────────────────────────┴──────────────────────────────┘
```

> 📌 **最實際的差別**：log 掉了你會說「可惜」，稽核掉了你會說「那我們沒辦法證明」。
> 8.3.4 那個實測就是在講「稽核被悄悄掉了一筆」。

---

## 8.2 Spring Security 的事件體系

### 8.2.1 實測：一輪完整的操作，發了哪些事件

先把觀察工具寫出來——它只監聽最上層的兩個基底型別，所以不用列舉子類別：

```java
package com.example.lab09.ch08;

import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.security.authentication.event.*;
import org.springframework.security.authorization.event.AuthorizationDeniedEvent;
import org.springframework.security.authorization.event.AuthorizationEvent;
import org.springframework.security.core.session.AbstractSessionEvent;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;

/** 8.2 的觀察工具：把 Spring Security 發出的【每一個】事件收下來。 */
@Component
@Profile("a1 | a2 | a3 | a4 | ac")
public class EventProbe {

    public record Seen(String type, String detail) {}

    public final List<Seen> events = new CopyOnWriteArrayList<>();

    /** ⚠️ 只為了 8.3.5 的示範 —— 正式的稽核程式【絕對不要】留著 credentials */
    public volatile Object lastFailureCredentials;

    /** 認證相關：成功、各種失敗、登出… */
    @EventListener
    public void onAuthentication(AbstractAuthenticationEvent e) {
        events.add(new Seen(e.getClass().getSimpleName(), describe(e)));
        if (e instanceof AbstractAuthenticationFailureEvent)
            lastFailureCredentials = e.getAuthentication().getCredentials();
    }

    /** 授權相關 */
    @EventListener
    public void onAuthorization(AuthorizationEvent e) {
        String who = e.getAuthentication().get() == null ? "?" : e.getAuthentication().get().getName();
        String what = e instanceof AuthorizationDeniedEvent<?> ? "DENIED" : "GRANTED";
        events.add(new Seen(e.getClass().getSimpleName(), what + " " + who + " → " + shortObject(e.getObject())));
    }

    /** session 生命週期 */
    @EventListener
    public void onSession(AbstractSessionEvent e) {
        events.add(new Seen(e.getClass().getSimpleName(), ""));
    }

    public void clear() { events.clear(); }

    public long count(String simpleName) {
        return events.stream().filter(s -> s.type().equals(simpleName)).count();
    }

    public Map<String, Long> summary() {
        Map<String, Long> m = new LinkedHashMap<>();
        for (Seen s : events) m.merge(s.type(), 1L, Long::sum);
        return m;
    }

    private static String describe(AbstractAuthenticationEvent e) {
        String s = e.getAuthentication().getName();
        if (e instanceof AbstractAuthenticationFailureEvent f)
            s += "  ← " + f.getException().getClass().getSimpleName();
        return s;
    }

    private static String shortObject(Object o) {
        String s = String.valueOf(o);
        int i = s.indexOf('\n');
        if (i > 0) s = s.substring(0, i);
        return s.length() > 60 ? s.substring(0, 60) + "…" : s;
    }
}
```

**測試**：

```java
    @Test
    void whatEventsAreFired() {
        try (Lab8 lab = new Lab8("a2")) {                 // 表單登入 + session
            EventProbe probe = lab.probe();
            probe.clear();

            Web w = lab.web();
            w.formLogin("alice", "wrong");                // ① 用錯的密碼
            w.formLogin("alice", "pw");                   // ② 用對的密碼
            w.get("/a/me");                               // ③
            w.get("/a/admin/users");                      // ④ alice 不是管理員
            w.get("/a/public/ping");                      // ⑤
            w.post("/logout", "");                        // ⑥

            probe.events.forEach(s -> System.out.printf("   %-46s %s%n", s.type(), s.detail()));
        }
    }
```

**輸出**：

```
═══ 8.2.1 一輪完整的操作，發了哪些事件 ═══
① 用【錯的】密碼登入  → 302
② 用【對的】密碼登入  → 302
③ GET /a/me        → 200
④ GET /a/admin/users（alice 不是管理員）→ 403
⑤ GET /a/public/ping → 200
⑥ POST /logout       → 302

收到的事件（依序）：
    1. AuthenticationFailureBadCredentialsEvent       alice  ← BadCredentialsException
    2. AuthenticationSuccessEvent                     alice
    3. SessionFixationProtectionEvent                 alice
    4. InteractiveAuthenticationSuccessEvent          alice
    5. AuthorizationDeniedEvent                       DENIED alice → SecurityContextHolderAwareRequestWrapper[…
    6. LogoutSuccessEvent                             alice
```

**三個觀察**：

```
① 登入成功發了【兩個】事件：
   AuthenticationSuccessEvent            —— 每一次「認證發生」都發（8.2.2 會量給你看差多少）
   InteractiveAuthenticationSuccessEvent —— 「一個人真的在登入畫面登入了」★ 稽核要的是這個

② 中間那個 SessionFixationProtectionEvent 就是 04 章 4.3.1 的換 session id ——
   它也是一個可以監聽的事件（雖然通常不需要記）。

③ 第 ④ 步被擋下來（403），這裡【有】一個 AuthorizationDeniedEvent ——
   但那是【URL 層】的規則擋的。8.2.3 會示範：換成【方法層】的 @PreAuthorize 擋，
   同一個設定下就【一個事件都沒有】。
```

### 8.2.2 🔴 實測：無狀態 API 下，「登入事件」跟請求數一起長

```java
    @Test
    void basicFiresSuccessEventPerRequest() {
        try (Lab8 lab = new Lab8("a2")) {                 // 表單登入 ＋ session
            EventProbe probe = lab.probe();
            probe.clear();
            Web w = lab.web();
            w.formLogin("alice", "pw");
            for (int i = 0; i < 20; i++) w.get("/a/me");
            probe.summary().forEach((k, v) -> System.out.printf("   %-46s %d%n", k, v));
        }
        try (Lab8 lab = new Lab8("a1")) {                 // Basic ＋ STATELESS
            EventProbe probe = lab.probe();
            probe.clear();
            for (int i = 0; i < 20; i++) lab.as("alice", "pw", "/a/me");
            probe.summary().forEach((k, v) -> System.out.printf("   %-46s %d%n", k, v));
        }
    }
```

**輸出**：

```
═══ 8.2.2 🔴 「登入事件」在無狀態 API 下會爆量 ═══
── a2：表單登入 ＋ session，登入一次後打 20 個請求 ──
   AuthenticationSuccessEvent                     1
   InteractiveAuthenticationSuccessEvent          1

── a1：Basic ＋ STATELESS，打 20 個請求 ──
   AuthenticationSuccessEvent                     20
```

> 🔴 **無狀態認證（Basic、或每個請求驗一次 JWT）下，`AuthenticationSuccessEvent` 會跟著請求數一起長。**
>
> 如果你的稽核是「收到 `AuthenticationSuccessEvent` 就寫一筆登入紀錄」——
> 一天一億個請求就是一億筆「登入」，而且**看不出真正的登入時間點在哪**。
> 更糟的是這張表會在幾天內把磁碟塞滿，然後有人把稽核關掉。

**✅ 所以「登入」這件事要看的是**：

```
有 session 的 web  →  InteractiveAuthenticationSuccessEvent（一次登入一筆）
無狀態的 API       →  **你自己的 /api/auth/login 端點**（05 章 5.9）——
                     那裡才是「一次登入」。**驗證 token 不是登入。**
```

> 📌 這個區分回到 04 章 4.1 的那張「身分載體」表：
> **session 的世界裡「登入」是一個事件；token 的世界裡「登入」是【發 token】那一刻**，
> 之後每個請求只是「出示證件」，不是重新登入。

### 8.2.3 🔴 實測：授權事件——URL 層預設就發、方法層預設不發

```java
    @Test
    void urlLayerFiresButMethodLayerDoesNot() {
        for (String profile : new String[]{"a2", "a3"}) {
            try (Lab8 lab = new Lab8(profile)) {
                EventProbe probe = lab.probe();
                Web w = lab.web();
                w.formLogin("alice", "pw");                  // alice 沒有 order:refund 也不是 ADMIN

                probe.clear();
                w.get("/a/admin/users");                      // URL 層的規則擋
                long urlEvents = probe.count("AuthorizationDeniedEvent");

                probe.clear();
                w.post("/a/orders/1001/refund", "");           // service 上的 @PreAuthorize 擋
                long methodEvents = probe.count("AuthorizationDeniedEvent");
                // …印出來…
            }
        }
    }
```

**輸出**：

```
═══ 8.2.3 🔴 授權事件：URL 層與方法層的預設【不一樣】 ═══
設定                                                   URL 層被拒（/a/admin/users）        方法層被拒（@PreAuthorize）
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
a2：沒有宣告 AuthorizationEventPublisher bean           1 個事件 ✅                        0 個事件 🔴
a3：✅ 宣告了 SpringAuthorizationEventPublisher         1 個事件 ✅                        1 個事件 ✅
```

**這個差異寫死在兩個設定類別裡，各三行**：

```java
// URL 層：AuthorizeHttpRequestsConfigurer —— 沒有 bean 就【自己造一個】
if (context.getBeanNamesForType(AuthorizationEventPublisher.class).length > 0) {
    this.publisher = context.getBean(AuthorizationEventPublisher.class);
} else {
    this.publisher = new SpringAuthorizationEventPublisher(context);   // ★ 預設就有
}

// 方法層：PrePostMethodSecurityConfiguration —— 有 bean 才設，沒有就【不發】
eventPublisherProvider.ifAvailable(preAuthorize::setAuthorizationEventPublisher);
```

> 🔴 **所以預設狀態下：URL 層的拒絕有紀錄，方法層的拒絕沒有。**
>
> 而 03 章之後，你系統裡最細、最重要的那些權限判斷
> （`@PreAuthorize`、`@PostAuthorize`、資源層的歸屬判斷）**全部都在方法層**——
> 也就是**最該記的那一批，預設全部靜音**。

**✅ 補法就是宣告那一個 bean**：

```java
@Bean
AuthorizationEventPublisher authorizationEventPublisher(ApplicationEventPublisher publisher) {
    return new SpringAuthorizationEventPublisher(publisher);
}
```

> ⚠️ **這是本站第三次遇到「URL 層與方法層的預設不一樣」**：
>
> ```
> 3.4.3  hasRole("ROLE_ADMIN")   URL 層【啟動就失敗】、方法層【完全正常】
> 3.7.5  RoleHierarchy bean      URL 層【自動吃到】、方法層【不吃】
> 8.2.3  授權事件                  URL 層【預設就發】、方法層【預設不發】
> ```
>
> **這三個是同一個模式：兩層是各自獨立實作的，預設值不保證一致。**
> 看到任何「某某功能」時，都要分別在兩層各驗一次——不要假設。

### 8.2.4 🔴 實測：那「通過」的事件呢？

```
═══ 8.2.4 🔴 「那我把通過的也記下來」 ═══
10 個【成功】的請求 → 事件數：
   AuthorizationGrantedEvent                      10
```

`AuthorizationGrantedEvent` 是**每一條授權決策**各發一次——
URL 層一次、每一個 `@PreAuthorize` 各一次。一支打了三層 service 的端點，一個請求就是四、五個事件。

> ⚠️ Spring 官方文件對它的說明是：**它會非常吵，一般不建議監聽**。
> `SpringAuthorizationEventPublisher`（8.2.3 那個）**只發 DENIED**，這是刻意的設計——
> 上面那個 a4 情境是我們自己寫一個 publisher 硬把 GRANTED 也發出來，才看得到這個數字。

**✅ 「成功的操作」要怎麼稽核？在業務層記，不要在授權層記**：

```
❌ 「alice 通過了 /api/orders/1001 的授權檢查」   ← 沒有業務意義，量又大
✅ 「alice 在 10:31 退款了訂單 1001，金額 1280」  ← 這才是稽核要的東西（8.3）
```

### 8.2.5 事件清單總表

```
┌────────────────────────────────────────┬──────────┬────────────────────────────────┐
│ 事件                                     │ 預設會發？ │ 稽核要不要記                      │
├────────────────────────────────────────┼──────────┼────────────────────────────────┤
│ AuthenticationSuccessEvent             │ ✅        │ ⚠️ 無狀態下會爆量（8.2.2）         │
│ InteractiveAuthenticationSuccessEvent  │ ✅        │ ★ 要（session 的世界裡＝一次登入）  │
│ AuthenticationFailureBadCredentialsEvent│ ✅       │ ★ 要（7.4 的鎖定也靠它）          │
│ AuthenticationFailureDisabledEvent     │ ✅        │ ★ 要（停用的帳號有人在試 = 訊號）   │
│ AuthenticationFailureLockedEvent       │ ✅        │ ★ 要                            │
│ AuthenticationFailureExpiredEvent      │ ✅        │ 要                              │
│ AuthenticationFailureCredentialsExpired│ ✅        │ 要                              │
│ LogoutSuccessEvent                     │ ✅        │ 要                              │
│ SessionFixationProtectionEvent         │ ✅        │ 不用（04 章 4.3.1 的正常行為）     │
│ SessionDestroyedEvent                  │ ✅ ※      │ 要（分辨「自己登出」與「被踢」）      │
│ AuthorizationDeniedEvent（URL 層）       │ ✅        │ ★ 要                            │
│ AuthorizationDeniedEvent（方法層）        │ 🔴 不發   │ ★ 要 —— 要先宣告 bean（8.2.3）    │
│ AuthorizationGrantedEvent              │ 🔴 不發   │ 不要（8.2.4，太吵）               │
└────────────────────────────────────────┴──────────┴────────────────────────────────┘
※ `SessionDestroyedEvent` 需要註冊 `HttpSessionEventPublisher`（04 章 4.3.2 為了 `SessionRegistry` 已經註冊過）。
```

> 📌 **`AuthenticationFailureDisabledEvent` 那一列值得特別看**：
> 「有人拿著**已停用帳號**的**正確密碼**在嘗試登入」是一個很強的訊號——
> 通常代表那組帳密外流了，或是離職員工還在試。它跟一般的密碼錯誤是**兩件事**，
> 稽核時要分得開（所以 `reason` 欄位存的是例外**類別名**，不是一句籠統的「登入失敗」）。

---

## 8.3 稽核紀錄

### 8.3.1 稽核要回答的五個問題

一筆稽核紀錄存在的唯一理由，是有一天有人會問這五個問題之一：

```
① 「這筆資料是誰改的？」                    → actor ＋ action ＋ target
② 「這個人這三個月做了什麼？」                → actor ＋ at（索引 idx_actor）
③ 「上週二 14:00～15:00 發生了什麼事？」      → at（索引 idx_at）
④ 「有沒有人在試我們的管理後台？」            → action ＋ outcome（索引 idx_action）
⑤ 「這個操作是從哪裡發出來的？」              → client_ip ＋ user_agent ＋ trace_id
```

**設計稽核表的方法很單純：把上面五個問題當成 SQL 寫一次，缺哪個欄位就補哪個。**

### 8.3.2 寫入點

```java
package com.example.lab09.ch08;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.sql.Timestamp;
import java.time.LocalDateTime;

/**
 * 8.3 的稽核寫入點。
 * ⚠️ 前兩個方法的差別【只有 propagation】—— 8.3.4 會量出它造成的差異。
 */
@Service
@Profile("a1 | a2 | a3 | a4 | au | ac")
public class AuditLog {

    public enum Outcome { SUCCESS, DENIED, FAILURE }

    private final JdbcTemplate jdbc;
    public AuditLog(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** 🔴 預設傳播行為：會【加入呼叫端的交易】—— 呼叫端回滾，這一筆也不見 */
    @Transactional
    public void write(String action, String targetType, String targetId, Outcome outcome, String reason) {
        insert(null, action, targetType, targetId, outcome, reason);
    }

    /** ✅ 獨立交易：呼叫端回滾也不影響它 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void writeInOwnTransaction(String action, String targetType, String targetId,
                                      Outcome outcome, String reason) {
        insert(null, action, targetType, targetId, outcome, reason);
    }

    /**
     * ★ 明確指定 actor 的版本。
     * 🔴 登入【失敗】與登出【之後】，`SecurityContextHolder` 是空的 ——
     *    那兩種紀錄的「誰」只能從【事件】裡拿，不能靠 SecurityContextHolder。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void writeAs(String actor, String action, String targetType, String targetId,
                        Outcome outcome, String reason) {
        insert(actor, action, targetType, targetId, outcome, reason);
    }

    private void insert(String actorOverride, String action, String targetType, String targetId,
                        Outcome outcome, String reason) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String actor = actorOverride != null ? actorOverride : (auth == null ? null : auth.getName());
        HttpServletRequest req = currentRequest();
        jdbc.update("""
                INSERT INTO audit_log
                  (at, actor, actor_id, action, target_type, target_id, outcome, reason,
                   client_ip, user_agent, trace_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                Timestamp.valueOf(LocalDateTime.now()),
                actor,                                            // 誰
                null,                                             // actor_id
                action,                                           // 做了什麼
                targetType, targetId,                             // 對什麼做
                outcome.name(),                                   // 結果
                reason,                                           // 為什麼（只在失敗時有值）
                req == null ? null : req.getRemoteAddr(),         // 從哪
                req == null ? null : trim(req.getHeader("User-Agent"), 255),
                null);                                            // trace_id（7.6.1 的那個編號）
    }

    // ⚠️ 上面有【兩欄永遠寫 null】，這是本節示範程式的簡化，不是建議做法：
    //   actor_id  —— 8.3.3 說「actor 與 actor_id 兩個都要」，因為帳號會改名。
    //                要填它，principal 得是你自己的型別（`AppPrincipal.userId()`）；
    //                但登入【失敗】那一筆本來就沒有 principal，所以這一欄註定可空。
    //   trace_id  —— 7.6.1 的那個編號。真正的做法是從 MDC / 分散式追蹤的 context 拿
    //                （`MDC.get("traceId")` 或 Micrometer 的 `Tracer.currentSpan()`），
    //                而不是在這裡再生一個——**兩邊生出來的編號對不起來就失去意義了**。
    //   📌 這兩欄是「欄位開好、但要接上別的東西才填得了」的典型：
    //      schema 先留著，接上之後不用改表。

    private static HttpServletRequest currentRequest() {
        var attrs = RequestContextHolder.getRequestAttributes();
        return attrs instanceof ServletRequestAttributes s ? s.getRequest() : null;
    }

    private static String trim(String s, int max) {
        return s == null ? null : (s.length() > max ? s.substring(0, max) : s);
    }
}
```

**把事件接上去**——注意它只挑**四種**事件，不是全收（8.2.2、8.2.4 解釋了為什麼）：

```java
package com.example.lab09.ch08;

import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.security.authentication.event.*;
import org.springframework.security.authorization.event.AuthorizationDeniedEvent;
import org.springframework.stereotype.Component;

/** 8.3.3：把 Spring Security 的事件變成稽核紀錄。 */
@Component
@Profile("au")
public class AuditListener {

    private final AuditLog audit;
    public AuditListener(AuditLog audit) { this.audit = audit; }

    /** ① 真正的「一次登入」—— 不是每個請求都發的那個（8.2.2） */
    @EventListener
    public void onLogin(InteractiveAuthenticationSuccessEvent e) {
        audit.writeAs(e.getAuthentication().getName(), "LOGIN", "user",
                e.getAuthentication().getName(), AuditLog.Outcome.SUCCESS, null);
    }

    /**
     * ② 登入失敗。
     * 🔴 這裡【只取 getName() 與例外類別名】——
     *    絕對不要 `e.getAuthentication().toString()`（8.3.5 會示範為什麼）。
     */
    @EventListener
    public void onLoginFailure(AbstractAuthenticationFailureEvent e) {
        String who = String.valueOf(e.getAuthentication().getName());
        // ★ actor 從事件裡拿 —— 這一刻 SecurityContextHolder 是空的
        audit.writeAs(who, "LOGIN", "user", who,
                AuditLog.Outcome.FAILURE, e.getException().getClass().getSimpleName());
    }

    /** ③ 授權被拒（方法層要靠 8.2.3 那個 bean 才會發） */
    @EventListener
    public void onDenied(AuthorizationDeniedEvent<?> e) {
        var auth = e.getAuthentication().get();
        audit.writeAs(auth == null ? null : auth.getName(), "ACCESS_DENIED", "resource",
                describe(e.getObject()), AuditLog.Outcome.DENIED, null);
    }

    @EventListener
    public void onLogout(LogoutSuccessEvent e) {
        // ★ 登出【之後】SecurityContextHolder 已經被清掉了（01 章 1.9.3）
        audit.writeAs(e.getAuthentication().getName(), "LOGOUT", "user",
                e.getAuthentication().getName(), AuditLog.Outcome.SUCCESS, null);
    }

    /** 方法層的 object 是一個 MethodInvocation —— 把它縮成「類別.方法」 */
    private static String describe(Object o) {
        if (o instanceof jakarta.servlet.http.HttpServletRequest r)
            return r.getMethod() + " " + r.getRequestURI();
        if (o instanceof org.aopalliance.intercept.MethodInvocation mi)
            return mi.getMethod().getDeclaringClass().getSimpleName() + "." + mi.getMethod().getName() + "()";
        String s = String.valueOf(o);
        return s.length() > 64 ? s.substring(0, 64) : s;
    }
}
```

> 🔴 **`writeAs` 那個「明確指定 actor」的設計不是多餘的。**
> 如果寫成「從 `SecurityContextHolder` 讀 actor」，實測結果是：
> **登入失敗與登出的那兩筆，`actor` 欄位都是 `null`** ——
> 因為那兩個時間點 `SecurityContextHolder` 本來就是空的（01 章 1.9.3 量過它的生命週期）。
> **「誰」必須從事件物件裡拿。**

### 8.3.3 實測：一輪操作留下的稽核紀錄

```
═══ 8.3.3 一輪操作留下的稽核紀錄 ═══
at                      actor      action           target                        outcome    reason / ip
──────────────────────────────────────────────────────────────────────────────────────────────────────────
2026-09-15T13:29:36.643 alice      LOGIN            user:alice                    FAILURE    BadCredentialsException  127.0.0.1
2026-09-15T13:29:36.740 alice      LOGIN            user:alice                    SUCCESS    null  127.0.0.1
2026-09-15T13:29:36.751 alice      ACCESS_DENIED    resource:GET /a/admin/users   DENIED     null  127.0.0.1
2026-09-15T13:29:36.799 alice      ACCESS_DENIED    resource:Ch08Service.refund() DENIED     null  127.0.0.1
2026-09-15T13:29:36.808 alice      LOGOUT           user:alice                    SUCCESS    null  127.0.0.1
```

**六個必要欄位，少一個就查不出事**：

```
who      actor / actor_id  —— ★ 兩個都要：帳號會改名，id 不會（03 章 3.10 同一個理由）
when     at                —— DATETIME(3)，毫秒；並且【統一時區】（存 UTC）
what     action            —— 動詞常數（LOGIN / ACCESS_DENIED / NOTE_UPDATE），不要自由字串
on what  target_type + id  —— 分兩欄，不要把 "note#17" 塞在一欄（之後查不動）
result   outcome           —— SUCCESS / DENIED / FAILURE，三態就夠
context  client_ip / user_agent / trace_id —— 出事時靠它們串起同一個人的一連串動作
```

> 📌 **注意第三、四列**：一個是 URL 層擋的（`GET /a/admin/users`），
> 一個是方法層擋的（`Ch08Service.refund()`）。
> **第四列只有在宣告了 8.2.3 那個 bean 之後才會出現。**

### 8.3.4 🔴 實測：業務失敗回滾，把稽核也一起回滾掉了

```java
package com.example.lab09.ch08;

import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 8.3.4 的主角：一個「先寫稽核、再做事」的交易方法。兩個版本的差別只有【稽核怎麼寫】。 */
@Service
@Profile("a1 | a2 | a3 | a4 | au | ac")
public class NoteService {

    private final JdbcTemplate jdbc;
    private final AuditLog audit;
    public NoteService(JdbcTemplate jdbc, AuditLog audit) { this.jdbc = jdbc; this.audit = audit; }

    /** 🔴 版本一：稽核跟業務在【同一個交易】裡 */
    @Transactional
    public void updateV1(long id, String body, boolean fail) {
        audit.write("NOTE_UPDATE", "note", String.valueOf(id),
                fail ? AuditLog.Outcome.FAILURE : AuditLog.Outcome.SUCCESS, fail ? "餘額不足" : null);
        jdbc.update("UPDATE note SET body=? WHERE id=?", body, id);
        if (fail) throw new IllegalStateException("餘額不足");      // ← 業務規則不通過
    }

    /** ✅ 版本二：稽核走【自己的交易】（REQUIRES_NEW） */
    @Transactional
    public void updateV2(long id, String body, boolean fail) {
        audit.writeInOwnTransaction("NOTE_UPDATE", "note", String.valueOf(id),
                fail ? AuditLog.Outcome.FAILURE : AuditLog.Outcome.SUCCESS, fail ? "餘額不足" : null);
        jdbc.update("UPDATE note SET body=? WHERE id=?", body, id);
        if (fail) throw new IllegalStateException("餘額不足");
    }

    // ── 下面兩個只是為了讓 8.3.4 的測試好寫 ──

    public String bodyOf(long id) {
        return jdbc.queryForObject("SELECT body FROM note WHERE id=?", String.class, id);
    }

    public long seed(String owner, String body) {
        jdbc.update("INSERT INTO note (owner_username, body) VALUES (?,?)", owner, body);
        return jdbc.queryForObject("SELECT MAX(id) FROM note", Long.class);
    }
}
```

**輸出**：

```
═══ 8.3.4 🔴 業務失敗回滾，把稽核紀錄也一起回滾掉了 ═══
版本                                             業務結果                    note 的內容      稽核紀錄
──────────────────────────────────────────────────────────────────────────────────────────────────
🔴 v1：audit.write()（同一個交易）                 丟 IllegalStateException   原本的內容       0 筆
✅ v2：REQUIRES_NEW（自己的交易）                  丟 IllegalStateException   原本的內容       1 筆
       → NOTE_UPDATE FAILURE 餘額不足
```

**v1 的三件事一起發生**：

```
‧ 業務失敗了（丟例外）           ← 對的
‧ note 的內容回到原樣             ← 對的，交易本來就該回滾
‧ **稽核紀錄也一起不見了**         ← 🔴 錯的

→ 「有人嘗試改這筆資料但失敗了」這個【最值得記的事實】，被交易吃掉了。
```

原因很單純：`@Transactional` 預設的傳播行為是 `REQUIRED` ——
`audit.write()` 看到呼叫端已經有交易，就**加入**它，於是同生共死。

**✅ 三種修法**：

```
① @Transactional(propagation = REQUIRES_NEW)（v2）
   —— 最直接。代價是這個請求同時佔【兩條】資料庫連線，連線池要留餘裕。
      （08 站 08 章量過連線池的行為；`max_connections` 不夠時這裡會先卡住。）

② 稽核不走資料庫，走 log 檔 / 訊息佇列
   —— 沒有交易問題；代價是查詢與關聯要另外做（11 站的題目）。

③ @TransactionalEventListener(phase = AFTER_COMPLETION) ＋ REQUIRES_NEW
   —— ⚠️ 只有 phase 沒有 REQUIRES_NEW 一樣寫不進去：
      AFTER_COMPLETION 時外層交易已經結束，沒有新交易就沒有東西可以 commit。
      這是「我明明加了 @TransactionalEventListener 為什麼還是沒寫進去」的標準答案。
```

> 📌 **這個問題是 03 章 3.5.6 的另一面。**
> 那裡是「`@PostAuthorize` 回了 403，但 `UPDATE` 已經 commit 了」——
> 交易在**最裡層**，所以授權擋不住它；
> 這裡是「業務回滾了，稽核也一起回滾」——稽核在**同一層**，所以被一起拖下水。
> **兩題的根源都是：你以為的執行順序，跟代理鏈的實際順序不一樣。**

### 8.3.5 🔴 實測：登入失敗事件裡有明碼密碼

```
═══ 8.3.5 🔴 登入失敗事件裡，有使用者剛剛打的【明碼密碼】 ═══
使用者在登入頁打了：alice / MySup3rSecret!（密碼是錯的）

   事件型別                              ： AuthenticationFailureBadCredentialsEvent
   e.getAuthentication().getCredentials()： MySup3rSecret!    ← 🔴 **使用者剛剛打的那個密碼，明碼**
   它的型別                              ： java.lang.String

   而 UsernamePasswordAuthenticationToken.toString() 會印出：
      UsernamePasswordAuthenticationToken [Principal=alice, Credentials=[PROTECTED],
      Authenticated=false, Details=null, Granted Authorities=[]]
```

**這是稽核程式最容易犯的錯**：

```java
❌ log.warn("login failed: {}", event.getAuthentication());        // 密碼進 log
❌ audit.write(..., event.getAuthentication().toString());         // 密碼進資料庫
❌ objectMapper.writeValueAsString(event);                         // 密碼進 ELK

✅ 只取你明確要的兩個欄位：
   event.getAuthentication().getName()                  // 帳號
   event.getException().getClass().getSimpleName()      // 失敗原因的類別名
```

> ⚠️ **注意 `toString()` 印出來的是 `Credentials=[PROTECTED]`——那只是 `toString` 有遮，
> 物件裡的值是明碼的。**
> 任何「把物件轉成 JSON」的路徑（Jackson、log 平台的 structured logging、
> APM 工具的自動序列化）都會把它挖出來，而且**不會有任何警告**。
>
> （對照 05 章 5.2.1：JWT 的 payload 看起來像亂碼，其實 `base64 -d` 一行就讀得到 —— 同一類錯覺。
> **「看起來被遮住」不等於「真的被遮住」。**）

> 📌 **為什麼 Spring 要留著明碼？** 因為 `ProviderManager` 要拿它去比對。
> 認證成功後 `ProviderManager.eraseCredentials()` 會把它清掉——
> 但**失敗的那條路沒有清**（失敗時整個 token 就被丟進事件了）。
> 所以「登入失敗事件」是全系統唯一一個手上有明碼密碼的地方，剛好也是最多人寫監聽器的地方。

### 8.3.6 要記什麼、絕對不能記什麼

```
┌────────────────────────────────┬──────────────────────────────────────────────┐
│ ✅ 一定要記                      │ 🔴 絕對不能記                                  │
├────────────────────────────────┼──────────────────────────────────────────────┤
│ 登入成功 / 失敗（含失敗原因分類）    │ 密碼（明碼或雜湊都不要，8.3.5）                  │
│ 登出、session 被踢（04 章 4.3.3） │ access / refresh token 全文（05 章 5.4.3）    │
│ 權限被拒（8.2.3）                 │ CSRF token、API key、TOTP 種子                 │
│ 權限 / 角色被【修改】              │ 信用卡號、CVV、身分證字號                       │
│ 帳號被停用 / 啟用 / 改密碼         │ 完整的請求 body（裡面什麼都有）                  │
│ 敏感資料的【讀取】（誰查了誰的資料）  │ 完整的標頭 Map（Authorization 在裡面）           │
│ 匯出 / 下載（多少筆、哪些欄位）      │ 使用者的健康 / 財務等特種個資（除非法遵要求）       │
│ 管理後台的每一個寫入操作            │ 別人的個資（稽核自己也會外洩，7.6.3）            │
└────────────────────────────────┴──────────────────────────────────────────────┘
```

**四個實務上的設計決定**：

```
① **稽核表要唯讀**：應用程式的資料庫帳號只給 INSERT 與 SELECT，不給 UPDATE / DELETE ——
   被入侵時攻擊者才擦不掉自己的足跡。
   更嚴格：稽核寫到另一台機器 / 另一個資料庫帳號 / append-only 的儲存。

② **保留期限要先決定**：90 天？一年？七年（金融）？
   決定了才知道要不要分區（partition）與歸檔 —— 不然兩年後那張表會大到查不動，
   然後有人「先清一下」，把最需要的那段歷史清掉。

③ **稽核本身也是個資**：誰能查稽核紀錄？查稽核這件事要不要記？（要。）

④ **不要用稽核表做業務查詢**（例如「使用者最後登入時間」）——
   那是業務欄位，放在 `app_user` 上。稽核表只做「事後追查」。
   一旦有人在稽核表上加索引來跑報表，它就會開始被當成業務表對待，然後就會有人想改它。
```

---

## 8.4 用 JPA Auditing 自動填「誰做的」

### 8.4.1 實測：`@CreatedBy` / `@LastModifiedBy`

8.3 記的是「發生了什麼事」，這一節記的是「這一列資料是誰寫的」——兩者互補。

```java
package com.example.lab09.ch08;

import jakarta.persistence.*;
import org.springframework.data.annotation.CreatedBy;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedBy;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.time.LocalDateTime;

/** 8.4：讓 Spring Data JPA 自動填「誰建立 / 誰最後修改」。 */
@Entity
@Table(name = "note")
@EntityListeners(AuditingEntityListener.class)          // ★ 沒有這一行，四個欄位永遠是 null
public class Note {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "owner_username", nullable = false)
    private String ownerUsername;

    @Column(nullable = false)
    private String body;

    @CreatedBy   @Column(name = "created_by") private String createdBy;
    @CreatedDate @Column(name = "created_at") private LocalDateTime createdAt;
    @LastModifiedBy   @Column(name = "updated_by") private String updatedBy;
    @LastModifiedDate @Column(name = "updated_at") private LocalDateTime updatedAt;

    protected Note() { }
    public Note(String ownerUsername, String body) { this.ownerUsername = ownerUsername; this.body = body; }

    public Long getId() { return id; }
    public String getBody() { return body; }
    public void setBody(String body) { this.body = body; }
    public String getCreatedBy() { return createdBy; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public String getUpdatedBy() { return updatedBy; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
}
```

```java
package com.example.lab09.ch08;

import org.springframework.context.annotation.*;
import org.springframework.data.domain.AuditorAware;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import java.util.Optional;

/**
 * 8.4：把 `@CreatedBy` / `@LastModifiedBy` 接到 SecurityContext。
 * ⚠️ 這個 `AuditorAware` 讀的是 `SecurityContextHolder` —— 也就是【當前執行緒】的那一份（01 章 1.9.1）。
 *    8.4.2 會示範換一條執行緒之後會發生什麼事。
 */
@Configuration
@Profile("au")
@EnableJpaAuditing(auditorAwareRef = "auditorAware")
@EnableAsync
public class JpaAuditingConfig {

    @Bean
    AuditorAware<String> auditorAware() {
        return () -> {
            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            if (auth == null || !auth.isAuthenticated()) return Optional.empty();
            if ("anonymousUser".equals(auth.getPrincipal())) return Optional.empty();   // ★ 匿名不算
            return Optional.of(auth.getName());
        };
    }
}
```

**一個把同一件事寫兩次的服務**（8.4.2 要用）：

```java
package com.example.lab09.ch08;

import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.concurrent.CompletableFuture;

/** 8.4.2：同一個寫入動作，一個在請求的執行緒上、一個丟到 @Async 的執行緒上。 */
@Service
@Profile("au")
public class NoteWriter {

    private final NoteRepo repo;
    public NoteWriter(NoteRepo repo) { this.repo = repo; }

    /** ① 就在當前執行緒寫 */
    public Note writeHere(String owner, String body) {
        return repo.saveAndFlush(new Note(owner, body));
    }

    /** 🔴 ② 丟到另一條執行緒寫 —— SecurityContextHolder 預設是 ThreadLocal（01 章 1.9.1） */
    @Async
    public CompletableFuture<Long> writeAsync(String owner, String body) {
        return CompletableFuture.completedFuture(repo.saveAndFlush(new Note(owner, body)).getId());
    }

    public Note find(long id) { return repo.findById(id).orElseThrow(); }
}
```

```java
package com.example.lab09.ch08;

import org.springframework.data.jpa.repository.JpaRepository;

/** ⚠️ Spring Data 只掃【最上層】的介面 —— 放在 @Configuration 裡面的巢狀介面掃不到。 */
public interface NoteRepo extends JpaRepository<Note, Long> { }
```

**輸出**：

```
═══ 8.4.1 `@CreatedBy` 自動填上「是誰做的」 ═══
POST /a/notes（alice 已登入）→ 200  {"id":3,"createdBy":"alice"}
   {id=3, body=第一筆, created_by=alice, created_at=2026-09-15T13:31:52.033, updated_by=alice}
```

**三個零件缺一不可**：

```
① @EnableJpaAuditing(auditorAwareRef = "auditorAware")   ← 打開這個功能
② @EntityListeners(AuditingEntityListener.class)          ← 掛在【每一個】要稽核的 Entity 上
③ 一個 AuditorAware<String> bean                          ← 回答「現在是誰」

🔴 最常見的失敗是【漏掉 ②】—— 啟動不報錯，欄位就是永遠 null。
   （做一個 `@MappedSuperclass` 的 `AuditableEntity` 把 ② 跟四個欄位一起繼承下去，
     就不會有人忘記。）
```

> ⚠️ **`@CreatedBy` 記的是「執行動作的人」，跟業務上的「擁有者」是兩回事**：
>
> ```
> ownerUsername   業務欄位：這筆資料【屬於】誰 —— 授權判斷用它（03 章 3.8）
> createdBy       稽核欄位：這筆資料【是誰寫的】—— 客服代客建立時，兩者不同
> → 不要拿 createdBy 做授權判斷，也不要拿 ownerUsername 當稽核。
> ```

### 8.4.2 🔴 實測：換一條執行緒，auditor 就不見了

```
═══ 8.4.2 🔴 丟到另一條執行緒，`@CreatedBy` 就變成 null ═══
寫入方式                               狀態碼          created_by
────────────────────────────────────────────────────────────────────────
① 請求的執行緒（同步）                       200          alice
🔴 ② @Async 的執行緒                   200          null
```

原因回到 01 章 1.9.2：`SecurityContextHolder` 預設用 `ThreadLocal` ——
**新的執行緒拿到的是一個空的 `SecurityContext`**，`AuditorAware` 只好回 `Optional.empty()`。

**✅ 三種修法**：

```
① 把身分【當參數傳過去】—— 最明確、最不會出錯，也最容易測
     auditService.record(username, ...)    // 而不是在背景執行緒裡讀 SecurityContextHolder

② 換成 MODE_INHERITABLETHREADLOCAL：
     SecurityContextHolder.setStrategyName(MODE_INHERITABLETHREADLOCAL);
   ⚠️ 01 章 1.9.4 量過它的坑：**執行緒池會把身分留在被重用的執行緒上**，
      下一個人可能撿到上一個人的身分 —— 比 null 危險得多。

③ 用 DelegatingSecurityContextExecutor / DelegatingSecurityContextAsyncTaskExecutor
   包住你的 executor —— Spring Security 提供的正解：
   **進入任務時複製一份、離開時清乾淨。**
```

> ⚠️ 同一個陷阱會出現在：`@Async`、`@Scheduled`、`CompletableFuture.supplyAsync`、
> `parallelStream()`、`WebClient` 的回呼、以及任何 `new Thread(...)`。
> **只要「做事的執行緒」不是「收請求的執行緒」，身分就要自己帶過去。**

> 📌 **`null` 其實是這三種結果裡最好的一種**：
> 它會讓你發現問題。真正危險的是選項 ② 沒設好時的「撿到上一個人的身分」——
> **稽核紀錄上寫著錯的人，比沒有稽核紀錄更糟。**

---

## 8.5 `spring-security-test`：怎麼測「帶著身分的請求」

### 8.5.1 🔴 實測：MockMvc 預設沒有掛上 Security

這是本章最重要的一個實測——因為它會讓**所有**授權測試變成假的，而且**全部是綠燈**。

```java
    @Test
    @WithMockUser(username = "alice", roles = "USER")
    void withoutSpringSecurityTheChainIsNotThere() throws Exception {
        MockMvc naked = MockMvcBuilders.webAppContextSetup(ctx).build();                        // ❌ 少了一行
        MockMvc real  = MockMvcBuilders.webAppContextSetup(ctx).apply(springSecurity()).build(); // ✅

        for (String path : new String[]{"/a/me", "/a/admin/users", "/a/public/ping"})
            System.out.printf("%-46s %-16s %-16s%n", "GET " + path,
                    naked.perform(get(path)).andReturn().getResponse().getStatus(),
                    real.perform(get(path)).andReturn().getResponse().getStatus());
    }
```

**輸出**：

```
═══ 8.5.1 🔴 MockMvc 預設【沒有】套上 Security Filter Chain ═══
請求                                             沒有 springSecurity()  有 springSecurity()
──────────────────────────────────────────────────────────────────────────────────
GET /a/me                                      200              200
GET /a/admin/users                             200              403
GET /a/public/ping                             200              200
```

> 🔴 **`/a/admin/users`：alice 不是管理員，但左邊那一欄是 200。**
>
> 因為 `webAppContextSetup(ctx)` 只裝了 `DispatcherServlet`——
> **`springSecurityFilterChain` 是一個 Servlet Filter，它不在裡面。**
>
> 換句話說：沒有那一行，你寫的每一個「授權測試」都只是在測 Controller，
> **完全沒有測到授權**。而且它會**全部綠燈**，所以沒有人會發現。

**✅ 兩種正確的接法**：

```java
// ① @SpringBootTest + @AutoConfigureMockMvc —— Boot 會【自動】套上 springSecurity()
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles({"db", "au"})
class MyAuthzTest {
    @Autowired MockMvc mvc;      // 這個 mvc 已經掛好了
}

// ② 自己組 MockMvc 時，一定要補這一行
MockMvc mvc = MockMvcBuilders.webAppContextSetup(ctx)
        .apply(springSecurity())                       // ★
        .build();
```

> 📌 03 章 3.9.2 已經量過一次同一件事。**這裡再量一次，是因為它在真實專案裡實在太常見**——
> 通常的路徑是：某人為了「測 Controller 的回應格式」寫了一個 `webAppContextSetup` 的測試，
> 後來有人複製它去寫授權測試。

### 8.5.2 哨兵測試：證明 Security 真的在

```
═══ 8.5.2 怎麼確認 Security 真的掛上了 ═══
① 最簡單的辦法：寫一個【匿名一定要被擋】的測試當作哨兵
   匿名 GET /a/me → 302（401 或 302 都代表 Security 在）
```

```java
@Test
void securityIsActuallyWired() throws Exception {
    mvc.perform(get("/a/me"))                          // 不帶任何身分
       .andExpect(status().is3xxRedirection());        // 綠 = chain 有掛上
}
```

> ⚠️ **哨兵要預期哪一個狀態碼，取決於那條 chain 的 entry point**（01 章 1.8.2）：
> 表單登入是 **302**（轉去 `/login`）、Basic 與 JWT 是 **401**。
> 兩種都代表 Security 在——**唯一不能接受的是 200**。
> 所以寫成 `isUnauthorized()` 之前先確認你測的是哪一條 chain，
> 不然哨兵自己會一直紅，然後被人加上 `@Disabled`。

> ★ **這個測試保護的不是那一支端點，是【你其他所有授權測試的可信度】。**
> 每一個授權測試類別都值得放一個。

### 8.5.3 🔴 實測：`@WithMockUser` 的三個坑

**坑一：`roles` 會自動加 `ROLE_` 前綴，`authorities` 不會**

```
═══ 8.5.3 坑一 ═══
@WithMockUser(roles = "ADMIN")             → {"principalClass":"…userdetails.User","name":"admin","authorities":"[ROLE_ADMIN]"}
🔴 @WithMockUser(authorities = "ADMIN")    → {"principalClass":"…userdetails.User","name":"admin","authorities":"[ADMIN]"}
   GET /a/admin/users（規則是 hasRole("ADMIN")）→ 403
```

```
roles = "ADMIN"            → 權限是 ROLE_ADMIN   ✅ 對得上 hasRole("ADMIN")
roles = "ROLE_ADMIN"       → ✅ Spring 直接擋住你，測試還沒開始跑就失敗：
                               IllegalStateException: Unable to create SecurityContext…
                               Caused by: IllegalArgumentException: roles cannot start with ROLE_ Got ROLE_ADMIN
authorities = "ADMIN"      → 權限是 ADMIN         🔴 對不上 hasRole("ADMIN") → 403
authorities = "ROLE_ADMIN" → 權限是 ROLE_ADMIN    ✅
```

> ★ **只有 `authorities = "ADMIN"` 那一格是「安靜地錯」**：
> 它不報錯、只是 403，於是很多人以為「授權規則寫錯了」，跑去改 production 的設定。
>
> ⚠️ 03 章之後改用 `hasAuthority("order:refund")` 的系統，
> 測試就要寫 `authorities = "order:refund"`（**不能寫 `roles`**，那會變成 `ROLE_order:refund`）。
>
> 📌 這是 03 章 3.4 那條「`hasRole` 自動補前綴、`hasAuthority` 不補」在**測試端**的鏡像。
> **同一條規則在三個地方各有一次表現**：授權設定、SpEL、測試註解。

**坑二：🔴 principal 不是你的 `UserDetails` 型別**

```
═══ 8.5.3 坑二 ═══
@WithMockUser                              → {"principalClass":"org.springframework.security.core.userdetails.User",…}
   GET /a/display-name（用 @AuthenticationPrincipal AppPrincipal 取）
   → 🔴 java.lang.NullPointerException
      Cannot invoke "com.example.lab09.ch08.AppPrincipal.displayName()" because "principal" is null
```

```
`@WithMockUser` 塞進去的 principal 是 Spring 內建的
`org.springframework.security.core.userdetails.User`，**不是**你自己的 principal 型別
（02 章 2.7.2 的 AppUserDetails / 04 章 4.8 的 ShopUserDetails）。

所以 `@AuthenticationPrincipal AppPrincipal p` 會拿到 `null`。

⚠️ 更糟的是它【不會報錯】—— `@AuthenticationPrincipal` 型別對不上就直接給 null，
   你的 Controller 才在下一行 NPE。測試看到 500，很難聯想到是 mock 的型別問題。
```

**坑三：🔴 它不查資料庫**

```
═══ 8.5.3 坑三 ═══
   使用者名稱：「根本不存在的人」，角色 ADMIN
   GET /a/admin/users → 200
   資料庫裡有這個人嗎？ 0 筆
```

```
`@WithMockUser` 是【直接把一個 Authentication 物件塞進 SecurityContext】——
它跳過了認證的整條路（02 章的三層委派全部沒有執行）。

這**不是缺點**，是它的用途：你在測【授權】，不是在測【認證】。但要記得它的邊界：

✅ 測得到   授權規則、@PreAuthorize、資源層歸屬判斷、Controller 行為
🔴 測不到   密碼比對、帳號停用/鎖定/過期（02 章的四個布林值）、
           UserDetailsService 的查詢、密碼升級（02 章 2.8）、登入的速率限制（7.4）
→ 那些要用【真的登入】來測（8.7）。
```

### 8.5.4 實測：`@WithUserDetails`——真的走一次 `UserDetailsService`

```
═══ 8.5.4 ✅ `@WithUserDetails` ═══
@WithUserDetails("alice")  → {"principalClass":"com.example.lab09.ch02.DbUserDetailsService$AppUserDetails",
                              "name":"alice","authorities":"[ROLE_USER]"}
```

principal 的型別變成 `AppUserDetails`（02 章 2.7.2 那個）——
因為 `@WithUserDetails` **真的去呼叫了你的 `UserDetailsService`**，
拿回來的就是你的程式產生的那個物件，不是 Spring 造的假貨。

**代價與前提**：

```
‧ 資料庫裡【必須真的有】這個帳號（所以每個測試前要 seed）
‧ 它會多打一次 DB，比 @WithMockUser 慢
‧ 權限來自資料庫，不是你在註解上寫的 —— 想測「某個特定權限組合」時反而不好控制

→ 實務上兩個都用：
  **測授權規則用 @WithMockUser（快、好控制），
    測「拿得到 principal 上的欄位」用 @WithUserDetails。**
```

### 8.5.5 實測：`SecurityMockMvcRequestPostProcessors`

註解是綁在**方法**上的，一個方法只有一種身分。`.with(...)` 寫在**請求**上，一個方法可以有很多種：

```
═══ 8.5.5 `.with(user(...))` 與 `.with(jwt(...))` ═══
請求                                                             狀態碼      說明
────────────────────────────────────────────────────────────────────────────────────
GET /a/admin/users（不帶身分）                                     302      匿名
.with(user("admin").roles("ADMIN"))                          200      ＝ @WithMockUser，但寫在請求上
.with(user("alice").roles("USER"))                           403      權限不夠

── `jwt()`：模擬 05／06 章的 token 身分 ──
.with(jwt())                                                 200      principal 變成 Jwt
      {"principalClass":"org.springframework.security.oauth2.jwt.Jwt","name":"user","authorities":"[SCOPE_read]"}

.with(jwt().jwt(j -> j.claim("scope", "order:read")))        200      scope → SCOPE_ 前綴
      {"principalClass":"…oauth2.jwt.Jwt","name":"user","authorities":"[SCOPE_order:read]"}

.with(jwt().authorities(new SimpleGrantedAuthority("order:refund"))) 200   直接指定權限
      {"principalClass":"…oauth2.jwt.Jwt","name":"user","authorities":"[order:refund]"}
```

**`.with(...)` 相對於註解的三個好處**：

```
① 一個測試方法裡可以用【好幾種身分】—— 註解是綁在方法上的，一個方法只有一種
② 參數化測試（@ParameterizedTest）能把身分當成參數傳進來 —— 8.6 的授權矩陣要用
③ jwt() / oauth2Login() / opaqueToken() 沒有對應的註解，只能用 post-processor
```

> ⚠️ **`jwt()` 的 scope 對應**：claim `scope` 的每一個值 → `SCOPE_xxx` 權限（06 章 6.6.3）。
> 如果你的規則寫的是 `hasAuthority("order:read")`（自家 RBAC），
> **`.jwt(j -> j.claim("scope", "order:read"))` 是對不上的**（那會變成 `SCOPE_order:read`）——
> 要用 `.authorities(...)` 直接指定。
> 這一格跟 8.5.3 坑一是同一種錯：**測試的身分跟 production 的權限命名對不上。**

**常用的 post-processor 一覽**：

| 寫法 | 模擬的是 | 對應章節 |
|---|---|---|
| `user("alice").roles("USER")` | 一般登入使用者 | 02 章 |
| `user(myUserDetails)` | 你自己的 `UserDetails` 物件 | 8.5.7 的另一種寫法 |
| `anonymous()` | 明確的匿名（覆蓋類別上的 `@WithMockUser`） | 01 章 1.4 |
| `jwt()` | 05 章的自簽 JWT / 06 章的第三方 token | 05、06 章 |
| `opaqueToken()` | 不透明 token（要打 introspection 端點那種） | 06 章 |
| `oauth2Login()` | 已經用 Google 登入完成的 session | 06 章 6.5 |
| `httpBasic("alice", "pw")` | Basic 認證（★ 真的會走認證流程） | 02 章 2.4 |
| `csrf()` | 帶一個有效的 CSRF token | 04 章 4.4 |

### 8.5.6 🔴 實測：忘記 `.with(csrf())`

```
═══ 8.5.6 🔴 CSRF 開著的時候，POST 一定要 `.with(csrf())` ═══
請求                                                         狀態碼      為什麼
────────────────────────────────────────────────────────────────────────────────────────────────
POST /a/orders/1001/refund（忘了 csrf()）                    403      🔴 CsrfFilter 擋的，跟權限無關
POST /a/orders/1001/refund（.with(csrf())）                  200      ✅
POST …（.with(csrf().useInvalidToken())）                    403      故意給錯的 token → 確認 CsrfFilter 真的在檢查
```

> 🔴 **第一列那個 403 看起來跟「權限不足」一模一樣**——
> 於是很多人會去改授權規則（把端點放寬），結果把 production 改壞了。

**✅ 分辨的方法：看回應 body**

```
CSRF 被擋       body 會提到 "Invalid CSRF Token" / "CSRF Token ... was not found"
授權被擋        body 是 Access Denied（或你自己的 AccessDeniedHandler 的格式）
—— 或者更快：**先補一個 `.with(csrf())` 試試看。**
```

**`csrf().useInvalidToken()` 那一列的用途**，是一個**正向的測試**：
它證明你的 CSRF 防護**真的開著**。
只寫「帶了 token 會過」測不出「不帶 token 會不會被擋」（04 章 4.4 的完整攻擊流程）。

### 8.5.7 實測：自訂註解，一次解掉坑二與坑三

```java
package com.example.lab09.ch08;

import org.springframework.security.test.context.support.WithSecurityContext;

import java.lang.annotation.*;

/**
 * 8.5.7 自訂測試註解：塞進去的是【你自己的】UserDetails 型別，
 * 所以 `@AuthenticationPrincipal` 拿得到東西（對照 8.5.3 坑二）。
 */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.TYPE})
@WithSecurityContext(factory = WithMockAppUserFactory.class)     // ★ 關鍵：指定一個 factory
public @interface WithMockAppUser {
    long userId() default 1L;
    String username() default "alice";
    String displayName() default "測試使用者";
    String[] authorities() default {};
}
```

```java
package com.example.lab09.ch08;

import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.*;
import org.springframework.security.test.context.support.WithSecurityContextFactory;

/** 8.5.7：把 `@WithMockAppUser` 變成一個 SecurityContext。 */
public class WithMockAppUserFactory implements WithSecurityContextFactory<WithMockAppUser> {

    @Override
    public SecurityContext createSecurityContext(WithMockAppUser a) {
        AppPrincipal principal = AppPrincipal.of(                   // ★ 你自己的型別
                a.userId(), a.username(), a.displayName(), a.authorities());
        SecurityContext ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(new UsernamePasswordAuthenticationToken(
                principal, principal.getPassword(), principal.getAuthorities()));
        return ctx;
    }
}
```

**用起來**：

```java
    @Test
    @WithMockAppUser(username = "alice", displayName = "艾莉絲", authorities = {"order:read"})
    void customAnnotation() throws Exception { … }
```

**輸出**：

```
═══ 8.5.7 自訂 `@WithMockAppUser` ═══
   GET /a/principal    → {"principalClass":"com.example.lab09.ch08.AppPrincipal","name":"alice","authorities":"[order:read]"}
   GET /a/display-name → {"displayName":"艾莉絲"}
```

**這個註解同時解掉坑二與坑三**：

```
‧ principal 是【你自己的型別】→ @AuthenticationPrincipal 拿得到，不會 null
‧ 不用碰資料庫 → 跟 @WithMockUser 一樣快、一樣好控制
‧ 權限寫在註解上 → 一眼看得出這個測試在測什麼權限組合
‧ 只有兩個檔案（一個註解 ＋ 一個 factory），寫一次全專案用
```

> 📌 **判斷要不要做這個註解的標準很簡單**：
> 你的 Controller 有沒有用 `@AuthenticationPrincipal` 取自訂型別？
> 有 → 做（不然每個測試都要繞過那些端點）；沒有 → `@WithMockUser` 就夠了。

---

## 8.6 授權矩陣與覆蓋掃描

### 8.6.1 實測：授權矩陣

03 章 3.1.2 的 `Matrix` 是用來**觀察**的；這一節把同一張表變成**會紅燈的測試**。

```java
    /** 五個身分 */
    static final Map<String, RequestPostProcessor> WHO = new LinkedHashMap<>() {{
        put("匿名",    r -> r);
        put("alice",  user("alice").authorities(new SimpleGrantedAuthority("order:read")));
        put("cs",     user("cs").authorities(new SimpleGrantedAuthority("order:read"),
                                             new SimpleGrantedAuthority("order:refund")));
        put("admin",  user("admin").roles("ADMIN").authorities(new SimpleGrantedAuthority("ROLE_ADMIN"),
                                             new SimpleGrantedAuthority("order:refund")));
        put("JWT(scope=order:read)", jwt().jwt(j -> j.claim("scope", "order:read")));
    }};

    /**
     * ⚠️ `req` 是一個 `Supplier` 不是現成的 builder ——
     *    `MockHttpServletRequestBuilder.with(...)` 是【累加】的，同一個 builder 重複用
     *    會把前一格的身分一起帶著走（目前「最後一個贏」所以剛好對，但那是巧合）。
     *    每一格開一個新的才穩。
     */
    record Case(String label, Supplier<MockHttpServletRequestBuilder> req, Map<String, Integer> expect) {}

    static List<Case> cases() {
        return List.of(
            new Case("GET  /a/public/ping",     () -> get("/a/public/ping"),
                    Map.of("匿名", 200, "alice", 200, "cs", 200, "admin", 200, "JWT(scope=order:read)", 200)),
            new Case("GET  /a/me",              () -> get("/a/me"),
                    Map.of("匿名", 302, "alice", 200, "cs", 200, "admin", 200, "JWT(scope=order:read)", 200)),
            new Case("GET  /a/admin/users",     () -> get("/a/admin/users"),
                    Map.of("匿名", 302, "alice", 403, "cs", 403, "admin", 200, "JWT(scope=order:read)", 403)),
            new Case("POST /a/orders/1/refund", () -> post("/a/orders/1/refund"),
                    Map.of("匿名", 302, "alice", 403, "cs", 200, "admin", 200, "JWT(scope=order:read)", 403))
        );
    }

    @Test
    void authorizationMatrix() throws Exception {
        List<String> failures = new ArrayList<>();
        for (Case c : cases())
            for (var who : WHO.entrySet()) {
                int actual = mvc.perform(c.req().get().with(who.getValue()).with(csrf()))
                        .andReturn().getResponse().getStatus();
                int expected = c.expect().get(who.getKey());
                if (actual != expected)
                    failures.add(c.label() + " / " + who.getKey() + "：預期 " + expected + " 實際 " + actual);
            }
        assertEquals(List.of(), failures, "授權矩陣有格子不符合預期");
    }
```

**輸出**：

```
═══ 8.6.1 授權矩陣：一次釘住「誰能打哪一支」 ═══
請求 \ 身分                   匿名            alice         cs            admin         JWT(scope=order:read)
──────────────────────────────────────────────────────────────────────────────────────────────
GET  /a/public/ping       200           200           200           200           200
GET  /a/me                302           200           200           200           200
GET  /a/admin/users       302           403           403           200           403
POST /a/orders/1/refund   302           403           200           200           403
```

> ★ **這張表就是你的授權規格書。它的價值不在「現在是綠的」，在改動時會紅**：
>
> ```
> ‧ 有人為了解 bug 把 /a/admin/users 改成 permitAll  → 「匿名」那一格從 302 變 200 → 紅
> ‧ 有人把 @PreAuthorize 標到 private 方法上（03 章 3.5.5）→ alice 那一格從 403 變 200 → 紅
> ‧ 有人加了一條規則但順序寫反（03 章 3.3.2）        → 某一整欄變色 → 紅
> ‧ 有人把 hasAuthority 改成 hasRole（8.5.3 坑一）    → cs 那一欄變 403 → 紅
> ```

**兩個寫法上的要求**：

```
① **每一格都要寫死預期值**，不要用「不是 200 就好」——
   403 與 302 是兩件不同的事（一個是「權限不夠」，一個是「請先登入」），
   而 03 章 3.8.4 的 403 vs 404 更是刻意的設計決定。

② **一定要有「匿名」那一欄。**
   大部分的授權事故是「本來要登入的變成不用登入」，
   而只測登入使用者的矩陣【看不到它】。
```

> 📌 **矩陣要放幾格？** 身分數 × 端點數會爆炸，所以挑：
> ```
> 身分：匿名 ＋ 每一個角色各一個 ＋ 「同角色的另一個人」（測資源層，03 章 3.8）
> 端點：每一條授權規則至少一支 ＋ 所有的寫入端點 ＋ 所有的管理端點
> → 通常 5 個身分 × 15～30 支端點就蓋得夠，跑起來幾秒鐘。
> ```

### 8.6.2 實測：覆蓋掃描——哪些端點沒有人專門保護

```
═══ 8.6.2 覆蓋掃描：哪些端點只靠 `anyRequest()` 兜底 ═══
只被 `anyRequest().authenticated()` 蓋到、又沒有方法層註解的端點：
   ⚠️ /a/display-name
   ⚠️ /a/me
   ⚠️ /a/notes
   ⚠️ /a/notes/async
   ⚠️ /a/orders/{id}/refund
   ⚠️ /a/principal
```

> ⚠️ **這個掃描只看得到「Controller 方法上」的註解** ——
> `/a/orders/{id}/refund` 其實是被 **service 上的** `@PreAuthorize` 保護的（8.2.3），
> 所以它被誤報了。**掃描是清單，不是判決**：它的用途是**逼你對每一行做一次判斷**。

**其餘那些端點不是沒有保護**（`anyRequest().authenticated()` 還在），
但它們的保護只有「有登入就好」——**任何一個登入的使用者都打得到**。
對只讀自己資料的端點沒問題；對「改別人資料」的端點就是一個洞（03 章 3.8）。

**✅ 把掃描變成一個測試**：

```java
@Test
void everyWriteEndpointHasAnExplicitRule() {
    var uncovered = scan().stream()
            .filter(e -> e.method() != GET)          // 只讀的端點可以只靠 authenticated()
            .filter(e -> !ALLOWLIST.contains(e.path()))   // 已經人工判斷過、確定沒問題的
            .toList();
    assertThat(uncovered).isEmpty();                 // 新增端點忘了加規則 → 紅燈
}
```

> ★ 它擋的是「**未來新增的端點忘了設規則**」，而那正是授權事故最常見的來源。
> （03 章 3.9.4 的 `AuthzCoverageReporter` 是同一件事的**啟動時**版本；
> 兩個都有價值：啟動時的給開發者看，測試的擋 CI。）

---

## 8.7 整合測試：`@WithMockUser` 測不到的那一半

### 8.7.1 實測：真的登入

```
═══ 8.7 真的登入：測 `@WithMockUser` 測不到的那一半 ═══
情境                                             POST /login  說明
────────────────────────────────────────────────────────────────────────────────────────────
正常帳號 ＋ 正確密碼                                  302          302 ＝ 登入成功
正常帳號 ＋ 錯誤密碼                                  302 ?error   密碼比對真的跑了一次 BCrypt
🔴 帳號被停用（carol）                              302 ?error   密碼是對的，但 enabled=false
🔴 帳號被鎖定（dave）                               302 ?error   accountNonLocked=false
🔴 帳號已過期（erin）                               302 ?error   accountNonExpired=false
🔴 密碼已過期（frank）                              302 ?error   credentialsNonExpired=false
帳號不存在                                        302 ?error   回應跟「密碼錯」一樣（7.3.3）
```

> ★ 上面那四個 🔴 —— 帳號狀態的四個布林值（02 章 2.3）——
> **`@WithMockUser` 一個都測不到**，因為它根本沒有走過認證。
> 而「**把離職員工停用了，他卻還登得進來**」正是最常見的事故之一。

> 📌 順帶注意：**七種情境的回應完全一樣**（都是 `302 → /login?error`）。
> 那是 7.3.3 要的結果——對外不洩漏差異。
> 但也因此，**這七格必須靠測試釘住**，人眼看回應是看不出來的。

### 8.7.2 三層測試各負責什麼

```
┌──────────────────────┬────────────────────────────────┬──────────────────────────┐
│ 層級                  │ 測什麼                           │ 怎麼寫                     │
├──────────────────────┼────────────────────────────────┼──────────────────────────┤
│ 單元（不起 context）    │ 你自己的判斷邏輯：                 │ 直接 new 出來呼叫           │
│                      │ 「這筆訂單是不是他的」               │ （最快、最該多寫）          │
│                      │ 「這個 token 過期了沒」             │                          │
├──────────────────────┼────────────────────────────────┼──────────────────────────┤
│ 切片（MockMvc）        │ 授權規則、@PreAuthorize、          │ @SpringBootTest ＋         │
│                      │ CSRF、回應狀態碼與格式              │ @AutoConfigureMockMvc ＋   │
│                      │ ★ 8.6 的授權矩陣在這一層            │ @WithMockUser / .with(...) │
├──────────────────────┼────────────────────────────────┼──────────────────────────┤
│ 整合（真 HTTP）        │ 🔴 認證的整條路：                  │ 起真的 server ＋ 真的 HTTP  │
│                      │ 密碼比對、帳號四個狀態、             │ client（本站的 Http / Web） │
│                      │ session 行為、登入速率限制、          │ 慢，所以只寫【關鍵路徑】      │
│                      │ 轉址、cookie 屬性、安全標頭          │                          │
└──────────────────────┴────────────────────────────────┴──────────────────────────┘
```

⚠️ **常見的錯誤配置是「只有中間那一層」**：

```
‧ 授權矩陣寫得很完整，但沒有任何測試證明「停用的帳號登不進來」
‧ 每一個測試都起一個完整的 context（慢到大家開始 @Disabled）
→ 判斷邏輯往下推到單元測試，認證路徑往上收斂成【幾個】整合測試。
```

> 📌 **本站每一章的實測，用的就是第三層。**
> `Http`（00 章 0.8.3，不跟隨轉址）與 `Web`（04 章 4.1.1，會記 cookie）
> 之所以要自己寫，就是因為 `TestRestTemplate` 會自動跟隨轉址，
> **把 302 變成 200，讓你看不出登入到底成功還是失敗**。

---

## 8.8 上線前安全檢查清單

這一節把 00～08 章的每一個 🔴 變成一條**可以勾、而且勾的時候知道要去看哪裡**的項目。

**用法**：每一條後面的括號是「去哪裡驗」。
不要只是讀過去——**打開你的專案，一條一條真的去看**。

### 8.8.1 認證（02 章）

```
□ 密碼用的是 BCrypt / Argon2 / scrypt，不是 MD5 / SHA-256 / 明碼        （0.7、2.9）
□ BCrypt 的 cost 是在【你的正式環境機器】上量過的，不是抄來的            （0.7.4 ★ 雲端 vCPU 通常慢 2～4 倍）
□ 用的是 DelegatingPasswordEncoder（`{bcrypt}` 前綴），未來換演算法不用停機  （2.8）
□ UserDetailsService 查不到人時丟 UsernameNotFoundException，
  【不是】回 null、也【不是】自己換一個例外                              （2.5.5 ★ 計時保護會失效 11849 倍）
□ 回的是 DTO 不是 JPA Entity                                        （2.7.3 ★ LazyInitializationException）
□ 容器裡【只有一個】UserDetailsService bean                          （2.6.3 ★ 兩個會 StackOverflowError，@Primary 無效）
□ 帳號停用 / 鎖定 / 過期 的四個布林值，都有測試證明「真的擋得住」          （8.7.1）
□ 停用一個帳號時，他手上【活著的 session 也被踢掉了】                    （2.7.7、04 章 4.3.3）
□ 而且【同時】撤掉了他的 API token（bump token_version）               （05 章 5.7.3、5.9）
```

### 8.8.2 授權（03 章）

```
□ 授權規則的順序：具體的在前、anyRequest() 在最後                       （3.3.2 ★ 順序寫反，後面那條一次都不會被評估）
□ 每一條寫入規則都指定了 HTTP 方法                                    （3.3.4 ★ 只寫 GET → 匿名 POST 拿到 200）
□ 有 anyRequest()，而且不是 permitAll()                             （3.3.8）
□ hasRole 與 hasAuthority 的前綴沒有搞混                             （3.4.3 ★ URL 層啟動就爆、方法層靜默正常）
□ @PreAuthorize 沒有標在 private 方法上、也沒有被同類別直接呼叫         （3.5.5 ★ 完全不生效，零警告）
□ @EnableMethodSecurity 真的加了                                    （3.5.2）
□ @PostAuthorize 沒有用在「會改資料」的方法上                          （3.5.6 ★ 回 403 但 UPDATE 已經 commit）
□ 列表的權限過濾寫在【查詢條件】裡，不是 @PostFilter                    （3.8.5 ★ 分頁直接 500）
□ 資源層的歸屬判斷用【查詢條件】，不是「查出來再比對」                     （3.8.3、3.8.6 ★ 差別是資料有沒有進 JVM）
□ 403 與 404 的選擇是【刻意決定】過的                                 （3.8.4）
□ 有一張授權矩陣測試，而且包含「匿名」那一欄                            （8.6.1）
□ 有覆蓋掃描：沒有規則保護的寫入端點會讓 CI 紅燈                        （8.6.2、3.9.4）
```

### 8.8.3 Session 與 CSRF（04 章）

```
□ 「關掉 CSRF」的理由是【身分載體不是 cookie】，不是「我們有 CORS」      （4.5.2、7.2.9）
□ token 存在 cookie 裡的話，CSRF 沒有關                              （4.5.2）
□ 沒有用「檢查 Referer」代替 CSRF token                              （4.4.3 ★ 攻擊者不送 Referer 就過了）
□ sessionFixation 不是 none()                                      （4.3.1）
□ maximumSessions 有設的話，principal 有正確的 equals/hashCode        （4.3.2 ★ 不然靜默失效）
□ 無狀態的 API 真的沒有長出 session（用 HttpSessionListener 量過）      （4.2.4 ★ 200 個請求漏 200 個）
□ cookie 有 HttpOnly / Secure / SameSite                            （4.5.2、4.5.3）
□ remember-me 被當成【弱身分】：敏感操作要重新驗證                      （4.6.2、4.6.3）
```

### 8.8.4 Token（05、06 章）

```
□ JWT 的 payload 裡沒有密碼、卡號、任何機密                            （5.2.1 ★ base64 一行就讀出來）
□ 一定有 exp，而且夠短                                               （5.3.2 ★ jjwt 不設也不報錯）
□ 驗簽用 `verifyWith(key)`，【不相信 token 自己宣稱的 alg】             （5.2.6 ★ RS256→HS256 金鑰混淆）
□ signWith 有寫死演算法（`Jwts.SIG.HS256`），不靠金鑰長度自動選          （5.2.3）
□ 沒有任何地方用 split(".") 自己讀 payload 當驗證                      （5.8.1 ★ 等於零驗證）
□ refresh token 【不是】JWT，而且有 rotation ＋ 重用偵測               （5.6.1、5.6.3）
□ 有一條「立刻撤銷」的路（黑名單 / 版本號 / 短命＋refresh）              （5.7）
□ 知道「權限是登入當下的快照」，改權限有對應的生效機制                    （5.5.2 ★ 改 DB 照樣 200）
□ OAuth2：公開 client 用 PKCE，沒有把 client secret 放進前端           （6.3.1）
□ OAuth2：state 有驗（用 oauth2Login 就自動有）                       （6.2.4）
□ 第三方帳號綁定用 (provider, sub)，不是 email                        （6.7.3 ★ email 被回收 bob 變 alice）
□ 驗 token 有驗 iss 與 aud                                          （6.8⑤）
```

### 8.8.5 跨來源與常見漏洞（07 章）

```
□ SecurityFilterChain 裡有寫 .cors(...)                             （7.2.6 ★ 宣告自訂 bean 之後就不再自動掛）
□ allowedOrigins 是逐一列舉，沒有 "*"、沒有 allowedOriginPatterns("*") （7.2.7、7.2.8）
□ CORS 註冊的路徑範圍蓋得住【全部】會被跨來源打的端點                    （7.2.9 ★ 漏一支就破功）
□ 前端要讀的回應標頭列進了 exposedHeaders                             （7.2.3）
□ 上線設定檔裡沒有殘留 http://localhost:*                            （7.2.10）
□ 登入 / 註冊 / 忘記密碼 三支端點，存在與不存在的回應【完全一樣】          （7.3.2）
□ 而且【回應時間】也一樣（量過中位數）                                 （7.3.4 ★ 註冊差 37 倍）
□ 登入失敗有速率限制，key 是「帳號＋IP」不是只有帳號                     （7.4.5 ★ 只鎖帳號＝DoS 工具）
□ 速率限制的 filter 在認證【之前】                                    （7.4.2 ★ 不然變成 CPU 攻擊面）
□ 沒有直接相信 X-Forwarded-For（有設 forward-headers-strategy）        （7.4.4）
□ 安全標頭齊全：CSP、HSTS、Referrer-Policy、Permissions-Policy、frame-ancestors （7.5.4）
□ HSTS 真的出現在回應裡（反向代理後面要設 forward-headers-strategy）     （7.5.2）
□ server.error.include-stacktrace / include-message 是 never          （7.6.1）
□ 有統一的錯誤出口 ＋ traceId                                        （7.6.1）
□ actuator 逐一 include、換到內網埠、而且照樣要求授權                   （7.6.2）
□ 轉址參數有白名單驗證（或者根本不開放）                                （7.7.1）
□ 沒有把 StrictHttpFirewall 換成 DefaultHttpFirewall                  （7.7.2）
```

### 8.8.6 稽核與測試（08 章）

```
□ 有宣告 AuthorizationEventPublisher bean（不然方法層的拒絕沒有紀錄）    （8.2.3）
□ 「登入」稽核看的是 InteractiveAuthenticationSuccessEvent
  或你自己的 /login 端點，不是 AuthenticationSuccessEvent             （8.2.2 ★ 無狀態下會爆量）
□ 稽核寫入用 REQUIRES_NEW（或走 log / 佇列）                          （8.3.4 ★ 不然會跟著業務回滾）
□ 監聽器裡【沒有】把整個 Authentication / event 印出來或序列化          （8.3.5 ★ 裡面有明碼密碼）
□ 稽核表是 append-only（應用程式的帳號沒有 UPDATE / DELETE 權限）       （8.3.6）
□ 稽核的保留期限已經決定、而且有歸檔計畫                                （8.3.6）
□ AuditorAware 在背景執行緒上的行為已經處理過                          （8.4.2）
□ MockMvc 真的掛上了 Security（有一個哨兵測試）                        （8.5.1、8.5.2）
□ 測試用的權限名稱跟 production 的命名對得上                           （8.5.3 坑一 ★ authorities vs roles）
□ CSRF 開著的端點，測試有 .with(csrf())；而且有一個 useInvalidToken 的反向測試 （8.5.6）
□ 授權矩陣測試存在，而且每一格都是寫死的預期值                          （8.6.1）
□ 有幾個【真的登入】的整合測試蓋住帳號四個狀態                          （8.7.1）
```

### 8.8.7 這張清單怎麼用

```
① **不要一次做完。** 挑「🔴 而且你現在就中招」的先做。
② **每做完一條，寫一個測試釘住它。** 沒有測試的修正，半年後會回來。
③ **把這張清單放進 PR 範本**（或 code review 的檢查項目）——
   它的價值在「下次有人改的時候會被問到」，不在「今天全部打勾」。
④ **每一條的括號都要去看一次。** 這張清單是索引，不是答案；
   答案在各章那個實測的輸出裡 —— 因為你要看的是【你自己系統上跑出來的數字】。
```

> ⚠️ **這張清單【不是】完整的資安檢查表。**
> 它只涵蓋「Spring Security 設定」這一層。**沒有涵蓋**的至少還有：
> SQL injection、XSS（前端）、檔案上傳、SSRF、反序列化、相依套件的已知漏洞、
> 基礎設施與網路、金鑰管理與輪替、備份與還原、以及人（社交工程）。
> 那些請對照 OWASP Top 10 與 ASVS。

---

## 8.9 shop-service 落地

這是本站最後一次改 shop-service。加上稽核與測試之後，它就完整了。

**① 稽核設定**（一個 bean ＋ 一個監聽器 ＋ 一張表）：

```java
package com.example.lab09.shop;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.*;
import org.springframework.security.authorization.AuthorizationEventPublisher;
import org.springframework.security.authorization.SpringAuthorizationEventPublisher;

/**
 * 08 章 8.2.3：沒有這個 bean，【方法層】的授權拒絕不會發事件 ——
 * 而 shop 的資源層判斷（03 章 3.8）全部在方法層。
 */
@Configuration
public class ShopAuditConfig {

    @Bean
    AuthorizationEventPublisher authorizationEventPublisher(ApplicationEventPublisher publisher) {
        return new SpringAuthorizationEventPublisher(publisher);
    }
}
```

**② 業務層的稽核**（成功的操作在這裡記，不在授權層記，8.2.4）：

```java
package com.example.lab09.shop;

import com.example.lab09.ch08.AuditLog;                 // 8.3.2
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 08 章的 shop 落地：把「成功 / 失敗的業務操作」記進稽核。
 * ⚠️ 用到的既有零件：`OrderRepo` / `Order`（03 章 3.10 的訂單表）、`AuditLog`（8.3.2）。
 */
@Service
public class ShopOrderService {

    private final OrderRepo orders;
    private final AuditLog audit;
    public ShopOrderService(OrderRepo orders, AuditLog audit) { this.orders = orders; this.audit = audit; }

    @Transactional
    @PreAuthorize("hasAuthority('order:refund')")
    public void refund(long orderId, String reason) {
        Order o = orders.findById(orderId).orElseThrow();
        try {
            o.refund();                                        // 業務規則可能丟例外
            // ★ 用 REQUIRES_NEW —— 業務回滾時稽核要留著（8.3.4）
            audit.writeInOwnTransaction("ORDER_REFUND", "order", String.valueOf(orderId),
                    AuditLog.Outcome.SUCCESS, reason);
        } catch (RuntimeException e) {
            audit.writeInOwnTransaction("ORDER_REFUND", "order", String.valueOf(orderId),
                    AuditLog.Outcome.FAILURE, e.getClass().getSimpleName());   // ★ 類別名，不是訊息全文（7.6.1）
            throw e;
        }
    }
}
```

**③ shop 的測試組合**：

```
ShopSecurityWiringTest      哨兵：匿名打 /api/orders/1001 → 401           （8.5.2）
ShopAuthzMatrixTest         授權矩陣：5 個身分 × 每一支端點，寫死預期值        （8.6.1）
ShopCoverageTest            覆蓋掃描：新增的寫入端點沒有規則 → 紅燈           （8.6.2）
ShopLoginIntegrationTest    真登入：帳號四個狀態 ＋ 鎖定 ＋ 轉址 ＋ 安全標頭    （8.7.1）
ShopAuditTest               稽核：登入失敗 / 授權拒絕 / 退款各留下一筆         （8.3.3）
ShopCorsTest                CORS：preflight、不合法的 Origin、exposedHeaders（07 章 7.2）
ShopJwtTest                 token：過期、篡改、撤銷後失效                   （05 章）
```

**④ 本站結束時，shop-service 的完整樣貌**：

```
認證      MySQL 的 app_user（BCrypt）＋ 表單登入（後台）＋ /api/auth/login 發 JWT（API）
         ＋ oauth2Login 接 Google，用 (provider, sub) 綁到同一個 app_user
授權      RBAC 五張表（角色 → 權限）＋ URL 層規則 ＋ 方法層 @PreAuthorize ＋ 資源層查詢條件
身分載體   後台：session cookie（CSRF 開）／ API：Authorization 標頭的 JWT（CSRF 關）
撤銷      停用帳號 → 同時踢 session ＋ bump token_version
跨來源     CORS 逐一列舉網域、只註冊在 /api/**
防護      登入速率限制（帳號＋IP、指數退避）＋ 安全標頭 ＋ 統一錯誤出口 ＋ actuator 收斂
稽核      登入 / 登出 / 授權拒絕 / 每一個寫入操作，REQUIRES_NEW 寫進 audit_log
測試      哨兵 ＋ 授權矩陣 ＋ 覆蓋掃描 ＋ 真登入整合測試
```

---

## 8.10 常見錯誤用法

**① 監聽 `AuthenticationSuccessEvent` 當「登入紀錄」**（8.2.2）
→ 無狀態 API 下它等於請求數。要看 `InteractiveAuthenticationSuccessEvent` 或你自己的登入端點。

**② 以為授權失敗一定會發事件**（8.2.3）
→ URL 層會，**方法層不會**，要自己宣告 `AuthorizationEventPublisher` bean。

**③ 監聽 `AuthorizationGrantedEvent` 記「成功的存取」**（8.2.4）
→ 每一條授權決策各發一次，量大又沒有業務意義。成功的操作在業務層記。

**④ 稽核用預設的 `@Transactional`**（8.3.4）
→ 業務回滾時稽核一起消失，而且**最該記的那些（失敗）剛好全部不見**。

**⑤ 在監聽器裡印整個 `Authentication` / 把 event 序列化**（8.3.5）
→ 明碼密碼進 log / 資料庫 / ELK。`toString()` 的 `[PROTECTED]` 是假象。

**⑥ 稽核的 actor 從 `SecurityContextHolder` 讀**（8.3.3）
→ 登入失敗與登出那兩筆會是 `null`，而那兩筆最重要。要從事件物件拿。

**⑦ 加了 `@CreatedBy` 但忘了 `@EntityListeners`**（8.4.1）
→ 欄位永遠是 null，啟動不報錯。

**⑧ 在 `@Async` / `@Scheduled` 裡讀 `SecurityContextHolder`**（8.4.2）
→ 空的。要嘛把身分傳過去，要嘛用 `DelegatingSecurityContext*Executor`。

**⑨ `MockMvcBuilders.webAppContextSetup(ctx).build()` 寫授權測試**（8.5.1）
→ 沒有 Security，測試全綠也全部沒測到。

**⑩ `@WithMockUser(authorities = "ADMIN")` 配 `hasRole("ADMIN")`**（8.5.3）
→ 403，而且不報錯。改規則是錯的方向，改測試才對。

**⑪ Controller 用 `@AuthenticationPrincipal` 取自訂型別，測試用 `@WithMockUser`**（8.5.3）
→ principal 是 `null` → NPE → 500。用 `@WithUserDetails` 或自訂註解。

**⑫ CSRF 開著卻忘了 `.with(csrf())`，然後去改授權規則**（8.5.6）
→ 那個 403 是 `CsrfFilter` 回的，不是授權。

**⑬ 授權矩陣沒有「匿名」那一欄**（8.6.1）
→ 最常見的事故（「本來要登入的變成不用登入」）剛好測不到。

**⑭ 只有 MockMvc 測試，沒有任何真登入的整合測試**（8.7）
→ 帳號停用 / 鎖定 / 過期、密碼比對、速率限制，通通沒有被測到。

---

## 8.11 常見誤區

**誤區 1：「我們有 log，就等於有稽核」**
→ 8.1.2：兩者的讀者、保留期限、可否遺失、可否修改都不同。
`log.info("user updated")` 這種字串，三個月後沒有人能從它回答「誰改了哪一筆」。

**誤區 2：「稽核越詳細越好，全部記下來」**
→ 8.2.4 量過 `AuthorizationGrantedEvent` 的量；8.3.6 列了不能記的東西。
**記太多的下場通常是「磁碟爆了，然後有人把稽核關掉」**——比一開始就記得少更糟。

**誤區 3：「稽核是法遵的事，跟工程無關」**
→ 稽核最常被用到的場合其實是**工程自己**：
「這個設定什麼時候被改的」「這個帳號是誰停用的」「這批資料是誰匯出的」。

**誤區 4：「測試通過就代表安全」**
→ 測試只證明「你想到的情況是對的」。
8.5.1 更進一步：**測試甚至可能連你想到的都沒測到**。
所以才需要哨兵測試（8.5.2）與反向測試（8.5.6 的 `useInvalidToken`）。

**誤區 5：「授權測試很難寫，以後再補」**
→ 8.6.1 的矩陣是一張表加一個迴圈，半小時可以寫完，而且是**整個系統 CP 值最高的測試**：
它一次蓋住所有端點 × 所有角色，而且改動時一定會紅。

**誤區 6：「`@WithMockUser` 就是登入」**
→ 8.5.3 坑三：它跳過了整條認證路徑。
**它測的是授權，不是認證。** 兩者要分開測。

**誤區 7：「稽核寫在 AOP 切面裡最乾淨」**
→ 部分同意：**登入 / 登出 / 授權拒絕**這種橫切的事件確實適合（8.3.3）。
但**業務操作的稽核不適合**——切面看不到「這次退款的金額與理由」，
它只看得到方法名與參數。業務稽核要寫在業務裡。

**誤區 8：「上線前跑一次檢查清單就好」**
→ 8.8.7：清單的價值在**每次改動都被問到**，不在上線那一天全部打勾。
放進 PR 範本比放進 wiki 有用得多。

---

## 8.12 本章小結

```
8.2  事件      認證事件預設都有；🔴 方法層的授權事件要自己開；GRANTED 太吵不要記
8.3  稽核      六個欄位；🔴 REQUIRES_NEW；🔴 事件裡有明碼密碼；append-only
8.4  JPA      @CreatedBy ＋ AuditorAware；🔴 換執行緒就不見
8.5  測試工具   🔴 springSecurity()；@WithMockUser 三個坑；post-processor；自訂註解
8.6  矩陣      一張表釘住「誰能打哪一支」；覆蓋掃描擋「新端點忘了設規則」
8.7  整合      帳號四個狀態、密碼比對、速率限制 —— 只有真登入測得到
8.8  清單      把 00～07 章的每一個 🔴 變成一條可以勾的項目
```

**一句話帶走**：

> **稽核回答「已經發生的事」，測試防止「還沒發生的事」。**
> 前七章寫的每一條規則，都要有這兩樣東西陪著它——
> 否則它只是「今天剛好是對的」，而不是「一直都是對的」。

### 8.12.1 驗收清單

```
□ Spring Security 發哪些事件？哪些預設有、哪些要自己開？
□ 為什麼「監聽 AuthenticationSuccessEvent 當登入紀錄」在無狀態 API 上是錯的？
□ URL 層與方法層的授權事件，預設值差在哪？為什麼這個差異特別危險？
□ 稽核表的六個必要欄位各回答什麼問題？為什麼 actor 要有兩欄？
□ 為什麼稽核寫入要 REQUIRES_NEW？不用會怎樣？
□ @TransactionalEventListener(AFTER_COMPLETION) 為什麼單獨用沒效？
□ 登入失敗事件裡有什麼不該記的東西？toString() 的 [PROTECTED] 為什麼靠不住？
□ 稽核的 actor 為什麼不能從 SecurityContextHolder 讀？
□ @CreatedBy 需要哪三個零件？漏掉哪一個會靜默失效？
□ AuditorAware 在 @Async 裡為什麼拿不到人？三種修法各自的代價？
□ MockMvc 怎麼掛上 Security？怎麼證明它真的掛上了？
□ @WithMockUser 的三個坑分別是什麼？各用什麼解？
□ @WithUserDetails 與 @WithMockUser 各適合測什麼？
□ .with(...) 相對於註解的三個好處？
□ .with(csrf()) 忘了會怎樣？怎麼分辨那個 403？
□ 授權矩陣為什麼一定要有「匿名」那一欄？
□ 哪些事情只能用真的登入來測？
```

### 8.12.2 本章練習

**練習一（觀察）：把你系統的事件全部印出來**
1. 抄 8.2.1 的 `EventProbe` 放進你的專案（記得加 `@Profile("!prod")`）。
2. 做一輪操作：登入失敗 → 登入成功 → 打一支沒權限的端點 → 登出。
3. 對照 8.2.5 的總表，看你少了哪些。
4. 加上 `AuthorizationEventPublisher` bean，再跑一次，看多了什麼。

**練習二（動手）：寫一張授權矩陣**
1. 列出你系統的所有角色（含「匿名」與「同角色的另一個人」）。
2. 列出所有**寫入**端點與所有**管理**端點。
3. 照 8.6.1 寫一張矩陣測試，每一格寫死預期值。
4. 故意把一條規則改成 `permitAll()`，確認它會紅。**如果沒紅，先修測試。**

**練習三（設計）：畫出你的稽核表**
```
哪些操作要記？（列出來，不要只寫「重要的都記」）
actor 怎麼取？登入失敗那一筆的 actor 從哪來？
寫入用什麼傳播行為？連線池夠嗎？
保留多久？誰決定的？到期怎麼處理？
誰能查？查稽核這件事要不要記？
稽核表的寫入權限是誰？應用程式的帳號能不能 DELETE？
```

**練習四（攻擊思考）：把 8.8 的清單跑一遍**
1. 挑你最有把握的三條，實際去專案裡驗（不要用記憶）。
2. 記錄有幾條「以為有做、其實沒有」。
3. 對那幾條，各寫一個測試。

**練習五（判斷）：這幾筆稽核紀錄，哪裡有問題？**
```
① {at: "2026-09-15 10:00", actor: null, action: "LOGIN", outcome: "FAILURE"}
② {at: "2026-09-15 10:01", actor: "alice", action: "登入系統並查看訂單", outcome: "OK"}
③ {at: "2026-09-15 10:02", actor: "alice", action: "UPDATE", target_id: "order#1001",
    reason: "UsernamePasswordAuthenticationToken [Principal=alice, Credentials=pw123…"}
④ {at: "2026-09-15 10:03", actor: "alice", action: "EXPORT", target_type: "customer",
    target_id: "all", outcome: "SUCCESS", client_ip: null}
```

---

## 8.13 本站總結

**09 站到這裡結束。** 回頭看一次這九章在做的同一件事：

```
00  威脅模型：先知道要防誰、防什麼        —— 沒有這一步，後面全是「照抄設定」
01  Filter Chain：請求穿過哪些關卡       —— 有了它，設定從玄學變成順序問題
02  認證：他是誰                        —— 三層委派、密碼雜湊、帳號狀態
03  授權：他能做什麼                     —— 三層（URL / 方法 / 資源）、RBAC
04  身分放在哪                          —— session vs 無狀態、CSRF
05  身分變成一張票                       —— JWT 的簽發、驗證、撤銷
06  票由別人發                          —— OAuth2 / OIDC、帳號綁定
07  從瀏覽器的角度看                     —— CORS、列舉、暴力破解、標頭、外洩
08  已經發生的事與還沒發生的事             —— 稽核與測試
```

**如果只能帶走五句話**：

```
① **先畫 Filter Chain，再改設定。**
   本站超過一半的「奇怪行為」，答案都是「那段程式碼在鏈上的位置不對」。

② **認證與授權是兩件事，而且授權有三層。**
   URL 層擋不了「改到別人的資料」，方法層擋不了「沒標註解的方法」，
   資源層才是真正決定「這一筆是不是他的」。

③ **每一個防護都會帶來新的攻擊面。**
   鎖帳號帶來 DoS（7.4.5）、快取帶來過期資料（2.7.4）、
   CORS 放寬帶來資料外洩（7.2.8）、稽核帶來個資風險（8.3.6）。
   安全不是「加東西」，是「做取捨，而且知道自己取捨了什麼」。

④ **「看起來被遮住」不等於「真的被遮住」。**
   JWT 的 payload（5.2.1）、`Authentication.toString()` 的 `[PROTECTED]`（8.3.5）、
   `/actuator/env` 的 `******`（7.6.2）—— 三次同一個教訓。

⑤ **靜默失效是最貴的失敗。**
   規則順序寫反（3.3.2）、`@PreAuthorize` 標在 private（3.5.5）、
   `maximumSessions` 沒有 equals（4.3.2）、`CorsConfigurationSource` 沒寫 `.cors()`（7.2.6）、
   方法層沒有授權事件（8.2.3）、MockMvc 沒掛 Security（8.5.1）——
   **它們的共同點是：啟動不報錯、測試全綠、要等到出事才知道。**
   所以本站每一章都在做同一件事：**把靜默的東西變成看得見的**
   （啟動報表、實測輸出、矩陣測試）。
```

### 下一站

```
10-redis       把 7.4 的速率限制、05 章的 token 黑名單、04 章的 session 搬到 Redis
               —— 單機的 ConcurrentHashMap 在多節點下全部失效
11-messaging   稽核與事件走訊息佇列（8.3.4 的修法二）
12-capstone    把 02～11 站組成一個完整的系統
13-distributed 服務之間怎麼傳身分（token 傳遞、服務間認證）
```

> 📌 **接下來最值得先做的一件事**：
> 回到 8.8 的清單，挑三條你「以為有做、但其實沒驗過」的，今天就去驗。
> **本站的每一個 🔴，都是某個人曾經以為自己做對了。**
