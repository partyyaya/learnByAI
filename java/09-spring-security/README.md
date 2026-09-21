# 09 — Spring Security（認證與授權）

> Spring Security 難學的原因是：它是一整條 Filter 鏈，而不是幾個註解。
> 只要先看懂「請求進來後被哪些 Filter 依序處理」，設定就會從玄學變成邏輯。
> 這一站從表單登入一路做到 JWT 與 OAuth2，並補上常見漏洞的防守面。

---

## 學完你可以

- 畫出 Spring Security 的 Filter Chain，說明認證資訊存在哪裡、何時被清掉。
- 實作自訂使用者來源與密碼雜湊，並說明為什麼不能用 MD5 存密碼。
- 設計權限模型（角色 vs 權限），並用方法層註解做細粒度控管。
- 說明 Session 與 Token 的取捨，以及無狀態 API 為什麼通常關掉 CSRF。
- 從零實作一套 JWT 認證：簽發、驗證過濾器、refresh token、登出撤銷。
- 接上第三方登入（Google / GitHub），理解 OAuth2 與 OIDC 的流程。
- 檢查一份設定是否有常見漏洞，並寫出帶身分的整合測試。

## 前置知識

[04-controller/](../04-controller/) 全部、[02-spring-boot/](../02-spring-boot/) 04 章（AOP）。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 這一章最值得看的 |
|------|------|------|------|
| 00 | [`00-course-map-security-fundamentals.md`](./00-course-map-security-fundamentals.md) | 課程地圖、認證與授權的分界 | 六個「程式碼看起來完全正確」的事故、401 vs 403、預設的 16 個 Filter、五種密碼演算法的實測耗時 |
| 01 | [`01-filter-chain-architecture.md`](./01-filter-chain-architecture.md) | 架構與 Filter Chain（核心章） | 設定 → Filter 清單的對照表、多條 chain 順序寫反、`addFilterAt` 不會取代任何東西、`SecurityContextHolder` 與執行緒 |
| 02 | [`02-authentication-userdetails-password.md`](./02-authentication-userdetails-password.md) | 認證機制 | 三層委派、`ProviderManager` 的六條規則、計時保護失效的四種寫法、帳號搬到 MySQL、密碼漸進升級 |
| 03 | [`03-authorization-and-method-security.md`](./03-authorization-and-method-security.md) | 授權與權限模型（核心章） | 授權的三層、`ROLE_` 前綴在兩層的不同待遇、方法層授權的三種失效方式、RBAC 五張表、資源層四種做法的成本 |
| 04 | [`04-session-vs-stateless-and-csrf.md`](./04-session-vs-stateless-and-csrf.md) | Session 與無狀態、CSRF | `STATELESS` 擋不住 session 被建立、`maximumSessions(1)` 靜默失效、CSRF 攻擊完整流程、什麼時候可以關 CSRF 的決策表 |
| 05 | [`05-jwt-authentication.md`](./05-jwt-authentication.md) | JWT 認證（核心章） | payload 是明文、`alg:none` 與金鑰混淆、自訂 Filter 的位置與骨架、權限是快照、refresh rotation 與撤銷三做法 |
| 06 | [`06-oauth2-and-social-login.md`](./06-oauth2-and-social-login.md) | OAuth2 / OIDC（核心章） | 本機跑一台真的 AS 當「Google」、授權碼流程逐步看封包、PKCE、`id_token` vs `access_token`、帳號綁定用 `(provider, sub)` |
| 07 | [`07-cors-and-common-vulnerabilities.md`](./07-cors-and-common-vulnerabilities.md) | 跨來源與常見漏洞 | 七種 CORS 寫法只有三種生效、那個 403 其實是被蓋掉的 401、CORS 擋不住 CSRF、帳號列舉、鎖定與安全標頭 |
| 08 | [`08-auditing-and-security-testing.md`](./08-auditing-and-security-testing.md) | 稽核與安全測試 | 授權事件在兩層的預設不同、稽核跟著交易回滾、事件裡有明碼密碼、`@WithMockUser` 三個坑、授權矩陣、上線前檢查清單 |

> 📌 **08 章 8.8 那份「上線前安全檢查清單」是本站的索引。**
> 它把 00～08 章的每一個 🔴 變成一條「可以勾、而且勾的時候知道要去看哪一節」的項目——
> 讀完整站之後，那一節是你最常回來翻的地方。

---

## 常見誤區（課程會逐一破解）

下面是最常見的十二個。**完整名單在 08 章 8.8**，每一條都對應到一節實測。

- 為了讓程式跑起來直接 `permitAll()` 全開，然後忘了改回來（00 章 0.3.2）。
- 密碼用 MD5 / SHA-256 存，甚至明碼存（00 章 0.3.3）。
- 自己寫 `UserDetailsService`，查不到人時 `return null`——時間差直接洩漏帳號存不存在（02 章 2.5.3）。
- 讓 JPA Entity 直接 `implements UserDetails`——帳密正確卻一直回 401（02 章 2.7.3）。
- 授權規則的順序寫反，後面那條**一次都沒有被評估過**——而且啟動不報錯（03 章 3.3.2）。
- `@PreAuthorize` 標在 `private` 方法、或被同類別直接呼叫——**完全不生效，零警告**（03 章 3.5.5）。
- 以為 `sessionCreationPolicy(STATELESS)` 就不會有 session——200 個請求漏了 **200 個**（04 章 4.2.4）。
- 「我們用 token 認證所以關掉 CSRF」——而那個 token **存在 cookie 裡**（04 章 4.5.2）。
- 用 JWT 卻沒設 `exp`——`io.jsonwebtoken` 不會報錯，你發出了一把永遠有效的鑰匙（05 章 5.3.2）。
- 第三方登入用 `email` 當帳號主鍵——email 被回收後，新員工 bob 用 Google 登入直接**變成** alice（06 章 6.7.3）。
- 照著建議宣告了 `CorsConfigurationSource` bean，卻忘了寫 `.cors()`——**自動掛載從此關閉，啟動不報錯**（07 章 7.2.6）。
- 用 `webAppContextSetup(ctx).build()` 寫授權測試——**全部綠燈，也全部沒測到**（08 章 8.5.1）。

---

## 基準專案

**整站只有一個專案**，每一章在它上面累加。00 章 0.8 會帶你把它建起來：

```
pom.xml                Boot 3.2.5 + starter-security + spring-security-test + bcprov
Http                   不跟隨轉址的裸 HTTP client —— 讓 302 不會被偽裝成 200（0.8.3）
SecurityChainReporter  啟動時印出整條 Filter Chain，並對設定錯誤發警告（0.8.4）
三個帳號 / 三張訂單      alice、bob（同角色）、admin —— 同角色的兩個帳號才測得出資源層授權
```

後面每一章加什麼（細節都在各章的「本章的實驗環境」）：

| 章 | 新增的資料表 / 相依 | 新增的觀察工具 |
|---|---|---|
| 02（2.1.1） | MySQL `app_user` / `authority`，七個蓋滿帳號狀態的帳號 | `AuthWiringReporter`（誰在驗密碼）、`/whoami` |
| 03（3.1.1） | RBAC 五張表 ＋ 訂單表 `ord3` ＋ 第五個帳號 `cs` | `AuthzRuleReporter`（授權規則表）、`Matrix`（授權矩陣）、`AuthzCoverageReporter` |
| 04（4.1.1） | 不需要新表 | `SessionCounter`、`Web`（會記 cookie 的瀏覽器替身）、`SessionWiringReporter` |
| 05（5.1.1） | JJWT ＋ `app_user.token_version`、`refresh_token`、`revoked_jti` | `TokenScope`（JWT 解剖器）、`JwtWiringReporter` |
| 06（6.1.1） | oauth2-client ＋ authorization-server、`social_identity` | 本機真 AS（`AuthServerConfig`，扮 Google）、`SocialAccountService` |
| 07（7.1.1） | `spring-boot-starter-actuator` | `Ch07Endpoints`（含一支**不在 CORS 範圍內**的 `/legacy/transfer`）、`Lab7.browserVerdict` |
| 08（8.1.1） | `audit_log`、`note` | `EventProbe`、`AuditLog`、`@WithMockAppUser` |

---

## 後面章節會取代前面的東西

一章一章做下來，有些類別會被**同名的新版**取代。看到這一格，就把舊的刪掉——
兩個一起留著會 `BeanDefinitionOverrideException`。

| 前面寫的 | 哪一章取代它 | 為什麼 |
|---|---|---|
| 00 章 0.8.4 的 `SecurityChainReporter` | 01 章 1.10 | 同一個類別的擴充版（多兩個警告），**直接覆蓋**，不要另開同名類別 |
| 00 章 0.3.0 的 `Users`（記憶體帳號） | 02 章 2.11 | 帳號改由 MySQL 供應，`ShopAuthConfig` 接手 `passwordEncoder` |
| 02 章 2.11 的 `ShopSecurityConfig` | 03 章 3.10 | 改名 `ShopAuthzConfig`；規則從「寫角色」改成「寫權限」，每條寫入規則都指定 HTTP 方法 |
| 03 章 3.10 的 `ShopAuthzConfig` | 04 章 4.8 | 補上 session 管理與「CSRF 為什麼可以關」的理由 |
| 03 章 3.10 的 `ShopUserDetails`（record） | 04 章 4.8 | record 的 `equals` 比對**所有**欄位，能用但脆弱——改成只比 `userId`（4.3.2） |
| 04 章 4.8 的 `ShopAuthzConfig`（Basic） | 05 章 5.9 | API 從 Basic 換成 JWT；`ShopUserDetails` 多帶 `tokenVersion`；停用帳號要**同時**踢 session 與 bump `token_version` |
| 04 章 4.8 的 `webChain` | 06 章 6.9 | 加上 `.oauth2Login(...)`，掛 `OidcUserService` 用 `sub` 綁到 `app_user` |
| 06 章 6.9 的兩條 chain | 07 章 7.8 | 改名 `ShopWebHardeningConfig`，補 `.cors(...)`、安全標頭、登入速率限制、actuator 收斂 |
| 02 章 2.11 起「登入失敗回 `?error`」 | 07 章 7.3.3 | 改成統一的 `failureHandler`——停用／鎖定／過期的訊息也要一致 |
| 07 章之前所有的「擋下來」 | 08 章 8.9 | 加 `ShopAuditConfig` ＋ `AuditListener`——否則**方法層的拒絕根本不發事件** |

⚠️ **另外兩處是「加一個東西，打壞了前面的工具」**，都在 07 章 7.1.1：
`spring-boot-starter-actuator` 讓容器多出第二個 `RequestMappingHandlerMapping`
（03 章 3.9.4 的 `CoverageTest` 要加 `@Qualifier`），
也讓 `AuthorizationManager` 被包成 `ObservationAuthorizationManager`
（03 章 3.2.4 / 3.9.4 兩個報表會**安靜地印出一張空表**，要先 `unwrap(...)`）。
**「只是加一個相依」永遠不只是加一個相依**——這件事本身就是 07 章的主題。

---

## 引用慣例

- **實測輸出的標頭就是節號**：每段輸出都會印 `═══ 節號 標題 ═══`，可以直接對回課文。
- **套件名分開實驗與成品**：`com.example.lab09.chNN` 是**刻意寫壞的實驗變體**，
  `com.example.lab09.shop` 才是本站建議的樣子（每章最後的「shop-service 落地」）。
- **每個實驗變體一個 `@Profile`**（00 章 0.3.0.1）：同章的變體常定義同名 bean，
  不隔離就 `BeanDefinitionOverrideException`。
  **讀者自己的專案只有一組設定，不需要這樣做。**
- **跨站引用**寫成「04 站 07 章 7.9」，站內引用寫成「01 章 1.7.3」。

## 本站的實測環境

章節裡的每一個數字，都是在這台機器上跑出來的：

| 項目 | 版本 |
|------|------|
| Spring Boot | 3.2.5 |
| Spring Security | 6.2.4 |
| JDK | Temurin 21.0.5 |
| MySQL | 8.0.46（02 章起；00～01 章用 H2） |
| 機器 | Apple M2 / macOS 14.2.1（8 顆邏輯核心） |

> ⚠️ **效能數字（0.7.3 的雜湊耗時）會因機器而異。**
> 那一節有一個「在你自己的機器上重跑」的步驟（0.7.4），
> **請照著做**——雲端的 vCPU 通常比筆電慢 2～4 倍，直接抄本課的 `cost` 會出事。

## 產出

替訂單系統加上完整的**帳號 / 角色 / 權限體系**：
JWT 登入與續期、第三方登入、方法層權限控管（買家只能看自己的訂單、管理員可看全部）、
CORS 與安全標頭、登入速率限制、稽核日誌，
以及一份帶身分的整合測試與**上線前安全檢查清單**（08 章 8.8）。
