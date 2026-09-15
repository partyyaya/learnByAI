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
攻擊者視角可對照 [../../security-course/](../../security-course/)。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 ✅ | [`00-course-map-security-fundamentals.md`](./00-course-map-security-fundamentals.md) | 課程地圖、認證與授權的分界 | **六個實測事故**、401 vs 403、授權的三層、預設的 16 個 Filter、威脅模型、**密碼雜湊的五種演算法實測** |
| 01 ✅ | [`01-filter-chain-architecture.md`](./01-filter-chain-architecture.md) | 架構與 Filter Chain（核心章） | 請求穿過的三層、TRACE 軌跡、16 個 Filter 逐一拆解、**設定 → Filter 清單對照**、多條 chain 與 `@Order`、例外的出口、`SecurityContextHolder` 與執行緒 |
| 02 ✅ | [`02-authentication-userdetails-password.md`](./02-authentication-userdetails-password.md) | 認證機制 | 三層委派、認證 Filter 的骨架、**Basic 的吞吐量上限**、`ProviderManager` 的六條規則、**計時保護失效的四種寫法**、`AuthenticationManager` 不是 bean、帳號搬到 MySQL、密碼漸進升級、密碼強度、自訂認證的三個層次 |
| 03 ✅ | [`03-authorization-and-method-security.md`](./03-authorization-and-method-security.md) | 授權與權限模型（核心章） | 授權的三層、**授權規則表**與**授權矩陣**兩個工具、URL 層的五個坑、`ROLE_` 前綴在兩層的**不同待遇**、方法層授權的**三種失效方式**、**`@PostAuthorize` 擋下來但交易已 commit**、RBAC 五張表、**資源層四種做法的成本**、403 vs 404、`@PostFilter` 遇上分頁、授權矩陣測試與端點覆蓋掃描 |
| 04 ✅ | [`04-session-vs-stateless-and-csrf.md`](./04-session-vs-stateless-and-csrf.md) | Session 與無狀態、CSRF | **身分載體設定報表**、`JSESSIONID` 何時長出來、**STATELESS 擋不住 session 被建立**、**200 個請求漏 200 個 session**、`sessionFixation` 四個選項、**`maximumSessions(1)` 靜默失效**、`expireNow()` 撤銷一個活著的 session、CSRF 攻擊完整流程、**Referer 檢查的兩難**、**什麼時候可以關 CSRF 的決策表**、`SameSite` 的四個缺口、remember-me 是弱身分、**提升信任等級** |
| 05 ✅ | [`05-jwt-authentication.md`](./05-jwt-authentication.md) | JWT 認證（核心章） | **payload 是明文**、簽章保完整性不保機密性、**`signWith` 自動選演算法**、`alg:none`、**RS256→HS256 金鑰混淆**、**沒 exp 的 token**、自訂 Filter 的位置與骨架、**驗證失敗不 throw 不自己回應**、`oauth2ResourceServer` 對照與**覆寫 `authenticationManager` 的坑**、**權限是快照（改 DB 照樣 200）**、**吞吐量 2322 vs 13**、refresh token **rotation + 重用偵測**、撤銷三做法（黑名單 / 版本號 / 短命+refresh）、**土炮解析的災難** |
| 06 ✅ | [`06-oauth2-and-social-login.md`](./06-oauth2-and-social-login.md) | OAuth2 / OIDC（核心章） | 四個角色、**本機跑一台真的 AS 當 Google**、授權碼流程逐步看封包、**code 只能用一次**、`state` 擋 CSRF、**公開 client 沒 secret 靠 PKCE**、**PKCE 擋授權碼攔截**、**id_token vs access_token（都是 JWT）**、`oauth2Login` 一行包整個流程、`oauth2ResourceServer` 用 **JWKS 公鑰**驗、`scope` vs `authority`、**帳號綁定用 (provider, sub) 不用 email**、**email 被回收 bob 變 alice** |
| 07 | `07-cors-and-common-vulnerabilities.md` | 跨來源與常見漏洞 | CORS 與 Security 的互動、密碼與帳號列舉、暴力破解與鎖定、機敏資料外洩、安全標頭 |
| 08 | `08-auditing-and-security-testing.md` | 稽核與測試 | 登入 / 權限事件稽核、`@WithMockUser`、`spring-security-test`、上線前安全檢查清單 |

---

## 常見誤區（課程會逐一破解）

- 為了讓程式跑起來直接 `permitAll()` 全開，然後忘了改回來。
- 密碼用 MD5 / SHA-256 存，甚至明碼存。
- JWT 把角色寫死在 payload 裡，改權限要等 token 過期才生效。
- 用 JWT 卻沒設過期時間，token 外洩等於帳號永久被拿走。
- 前端拿到 401 才判斷沒登入，後端 API 卻其實沒驗權限。
- CORS 與 CSRF 設定互相打架，改到能動就不敢再碰。
- 自己寫 `UserDetailsService`，查不到人時 `return null`——時間差直接洩漏帳號存不存在（02 章 2.5.3）。
- 讓 JPA Entity 直接 `implements UserDetails`——帳密正確卻一直回 401（02 章 2.7.3）。
- 把帳號停用了，那個人手上的 session 卻照樣能用（02 章 2.7.7）。
- 授權規則的順序寫反，後面那條**一次都沒有被評估過**——而且啟動不報錯（03 章 3.3.2）。
- 規則只寫了 `GET`，匿名的 `POST /api/admin/users` 拿到 **200**（03 章 3.3.4）。
- `@PreAuthorize` 標在 `private` 方法、或被同類別直接呼叫——**完全不生效，零警告**（03 章 3.5.5）。
- `@PostAuthorize` 回了 403，但那筆 `UPDATE` **已經 commit 了**（03 章 3.5.6）。
- 用 `@PostFilter` 做列表的權限過濾——遇上分頁直接 **500**（03 章 3.8.5）。
- 授權測試全綠，因為 `MockMvc` 根本沒套上 Security Filter Chain（03 章 3.9.2）。
- 以為 `sessionCreationPolicy(STATELESS)` 就不會有 session——200 個請求漏了 **200 個**（04 章 4.2.4）。
- `maximumSessions(1)` 設了卻毫無作用，因為 principal 沒有 `equals`/`hashCode`（04 章 4.3.2）。
- 「我們用 token 認證所以關掉 CSRF」——而那個 token **存在 cookie 裡**（04 章 4.5.2）。
- 用「檢查 `Referer`」代替 CSRF token——攻擊者**不送 Referer** 就過了（04 章 4.4.3）。
- 以為 `HttpOnly` 可以防 CSRF（它防的是 XSS，04 章 4.5.2）。
- 以為 JWT 的 payload「看起來是亂碼」，把密碼 / 卡號放進去——`base64 -d` 一行就讀出來（05 章 5.2.1）。
- 用 JWT 卻沒設 `exp`——`io.jsonwebtoken` 不會報錯，你發出了一把永遠有效的鑰匙（05 章 5.3.2）。
- 驗 JWT 時**相信 token 自己宣稱的 `alg`**——RS256 被降級成 HS256、用公鑰偽造（05 章 5.2.6）。
- 只想拿個 userId 就 `split(".")` 讀 payload——等於**完全沒有驗證**（05 章 5.8.1）。
- 把權限寫進 token，以為改 DB 就會生效——同一個 token **照樣 200**，那是登入當下的快照（05 章 5.5.2）。
- refresh token 也做成 JWT——就變成撤不掉的了；它**故意不是 JWT**（05 章 5.6.1）。
- 把 client secret 放進 SPA / App——前端人人可下載；公開 client 要靠 PKCE，不是 secret（06 章 6.3.1）。
- 手刻 OAuth flow 漏了 `state`——login CSRF：受害者帳號被綁上攻擊者的 Google 身分（06 章 6.2.4）。
- 拿 `id_token` 去打 API——那是「給 client 的身分證明」，存取權要用 `access_token`（06 章 6.4.1）。
- 第三方登入用 `email` 當帳號主鍵——email 被回收後，新員工 bob 用 Google 登入直接**變成** alice（06 章 6.7.3）。
- 前端自己 render 一個框收 Google 密碼——那正是 OAuth2 要消滅的，密碼只能在 Google 頁面輸入（06 章 6.2.1）。

## 目前進度

| 章節 | 狀態 |
|------|------|
| 00 課程地圖與安全基礎 | ✅ 可讀（2,865 行，26 個程式碼類別已編譯驗證） |
| 01 架構與 Filter Chain | ✅ 可讀（2,995 行，27 個程式碼類別已編譯驗證） |
| 02 認證機制 | ✅ 可讀（6,459 行，**38 個實測**，58 個程式碼類別已編譯驗證） |
| 03 授權與權限模型 | ✅ 可讀（7,417 行，**46 個實測**，87 個程式碼類別已編譯驗證） |
| 04 Session 與無狀態、CSRF | ✅ 可讀（4,083 行，**23 個實測**，25 個程式碼類別已編譯驗證） |
| 05 JWT 認證 | ✅ 可讀（2,547 行，**23 個實測**，26 個程式碼類別已編譯驗證、26 個測試實跑通過） |
| 06 OAuth2 / OIDC | ✅ 可讀（1,370 行，**11 個實測**，本機真 AS + client + resource server 三方跑通、11 個測試實跑通過） |
| 07～08 | ⏳ 未開始 |

**本站的實測環境**（章節裡的每一個數字都在這台機器上跑出來的）：

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

## 基準專案

00 章 0.8 會帶你建好整站共用的專案：

```
pom.xml                     Boot 3.2.5 + starter-security + spring-security-test + bcprov
Http                        不跟隨轉址的裸 HTTP client —— 讓 302 不會被偽裝成 200（0.8.3）
SecurityChainReporter       啟動時印出整條 Filter Chain，並對三種設定錯誤發警告（0.8.4、1.10）
三個帳號 / 三張訂單            alice、bob（同角色）、admin —— 同角色的兩個帳號才測得出資源層授權
```

02 章 2.1.1 會把帳號從記憶體搬到真的 MySQL，並加上第二個啟動檢查：

```
docker run … mysql:8.0      app_user / authority 兩張表（2.1.1）
七個帳號                     蓋掉 UserDetails 五個布林值的每一種狀態（正常 / 停用 / 鎖定 / 兩種過期）
AuthWiringReporter          啟動時印出 UserDetailsService / PasswordEncoder 各有幾個 bean（2.6.3）
/whoami                     本章所有 HTTP 實測共用的測試端點
```

04 章 4.1.1 **不需要新的表**，但會加三個觀察工具：

```
Ch04Endpoints          不碰 / 只讀 / 主動建立 session 的三類端點（4.2.3 靠它們分辨）
SessionCounter         一個 HttpSessionListener —— 4.2.4 用它量「漏了幾個 session」
Web                    會記住 cookie 的瀏覽器替身（00 章的 Http 刻意不帶 cookie）
SessionWiringReporter  啟動時印出每條 chain 的身分載體，並對「session + 關 CSRF」發紅色警告（4.1.2）
```

05 章 5.1.1 加 JJWT 相依、兩張新表 + 一個欄位，以及一個解剖器：

```
pom.xml                jjwt-api/impl/jackson 0.12.5 + starter-oauth2-resource-server（5.4.4 對照組用）
ALTER app_user         多一個 token_version 欄位 —— 版本號撤銷（5.7.3）
refresh_token 表        只存雜湊 + family_id —— refresh rotation 與重用偵測（5.6）
revoked_jti 表          jti 黑名單（5.7.2）
TokenScope             JWT 解剖器：不驗簽章、直接讀 payload，對六種危險設定發警告（5.1.1）
JwtWiringReporter       啟動時印出每條 chain 的「token 怎麼驗、撤不撤得掉」（5.1.2）← 第五個 reporter
```

06 章 6.1.1 加 oauth2-client + authorization-server 相依、一張綁定表，以及一台本機 AS：

```
pom.xml                starter-oauth2-client + spring-security-oauth2-authorization-server:1.2.4
social_identity 表      (provider, sub) → app_user.id 的唯一鍵；email 只記錄不當鍵（6.7.3）
AuthServerConfig       本機真 AS（扮 Google）：兩個 client（機密 shop-web / 公開 shop-spa）、RS256 簽章、OIDC（6.1.3）
ClientScenario         你的網站當 client：一個 ClientRegistration + 一行 oauth2Login（6.5）
ResourceServerScenario 你的 API 當 resource server：JWKS 指向 AS，驗 AS 發的 token（6.6）
SocialAccountService   用 sub 對應 / 建立 app_user；帳號連結（6.7）
```

03 章 3.1.1 會再加五張表，把「規則裡寫死角色」換成 RBAC：

```
app_role / permission / role_permission / user_role    角色 → 權限，改權限不用重新部署
ord3                        一張真的訂單表 —— 記憶體 Map 量不出 SQL 句數
第五個帳號 cs（客服）         跟 admin 不同角色、跟 alice 同樣不是管理員
AuthzRuleReporter           啟動時印出 AuthorizationFilter 手上的每一條規則與順序（3.2.4）
Matrix                      一次打一整張「請求 × 帳號」的表（3.1.2）—— 後面每一節都在用
AuthzCoverageReporter       掃出「只靠 anyRequest() 兜底、又沒有方法層註解」的端點（3.9.4）
```

## 後面章節修正了前面的地方

| 你在前面章節寫的 | 哪一章改了它 | 為什麼 |
|---|---|---|
| 02 章 2.1.1 的 `Seed.reset()`（`DELETE FROM authority` → `DELETE FROM app_user`） | **03 章 3.1.1** | 03 章的 `user_role` 有一條指向 `app_user` 的外鍵，`DELETE FROM app_user` 會被擋住，要先清 `user_role` |
| 02 章 2.7.2 的 `AppUserDetails`（只多帶 `displayName`） | **03 章 3.10** | 資源層的查詢條件要用 `userId`（帳號可以改名，id 不會），所以 principal 上要多帶一個 `userId` |
| 01 章 1.7.6 / 02 章 2.11 那兩條 chain 的授權規則 | **03 章 3.10** | 規則從「寫角色」改成「寫權限」（`hasAuthority`），而且每一條寫入規則都指定了 HTTP 方法 |
| 00 章 0.8.4 的 `SecurityChainReporter` | **01 章 1.10** | 同一個類別的擴充版（多了「沒有 `AuthorizationFilter`」與「匹配所有請求卻不是最後一條」兩個警告），**直接覆蓋**，不要另外開一個同名類別 |
| 00 章 0.3.0 的 `Users`（記憶體帳號 + `passwordEncoder`） | **02 章 2.11** | 帳號改由 MySQL 供應，`ShopAuthConfig` 接手 `passwordEncoder`；`Users` 要刪掉（實驗專案照 2.1.1 加 `@Profile` 隔離） |
| 02 章 2.11 的 `ShopSecurityConfig` | **03 章 3.10** | 改名為 `ShopAuthzConfig`，`apiChain` / `webChain` 是同名 bean，**舊的那個類別要刪掉** |
| 03 章 3.10 的 `ShopAuthzConfig` | **04 章 4.8** | 補上 session 管理（`sessionFixation` / `maximumSessions` / `expiredSessionStrategy`）與「CSRF 為什麼可以關」的理由；**同名 bean，舊的要刪掉** |
| 03 章 3.10 的 `ShopUserDetailsService.ShopUserDetails` | **04 章 4.8** | record 自動產生的 `equals` 比對**所有**欄位，能用但脆弱——改成只比 `userId`（4.3.2） |
| 02 章 2.7.2 的 `AppUserDetails` | **04 章 4.3.2** | 沒有 `equals` / `hashCode`，讓 `SessionRegistry` 把同一個人當成好幾個人 |
| 04 章 4.8 的 `ShopAuthzConfig`（apiChain 用 `httpBasic`） | **05 章 5.9** | API 從 Basic 換成 JWT（`addFilterBefore(new JwtAuthenticationFilter(...))`）；13 個/秒 → 2322 個/秒（5.5.3）；**同名 bean，舊的要刪掉** |
| 04 章 4.8 的 `ShopUserDetails`（比 `userId` 的 record） | **05 章 5.9** | 多帶一個 `tokenVersion` 欄位，版本號撤銷（5.7.3）要用；查詢多讀一欄 |
| 04 章 4.8 的 `ShopSessionAdmin.disable()`（只踢 session） | **05 章 5.9** | 停用帳號現在要**同時**踢 session（後台）**和** bump `token_version`（撤 API 的 JWT）——少一步那個人就從另一個入口繼續有效 |
| 04 章 4.8 的 `webChain`（只有 `formLogin`） | **06 章 6.9** | 加上 `.oauth2Login(...)` 與第三方登入並存；掛一個 `OidcUserService` 把「Google 的人」用 `sub` 綁到 `app_user`（6.7） |
| 03 章 3.10 起「權限只看自家 RBAC」 | **06 章 6.6.3** | 第三方 token 的 `scope`（`SCOPE_` 前綴）與你自己的 RBAC 角色是**兩層、疊加**的——scope 決定 client 能問什麼，RBAC 決定使用者能做什麼 |

## 引用慣例

- **實測輸出的標頭就是節號**：每段輸出都會印 `═══ 節號 標題 ═══`，可以直接對回課文。
- **套件名分開實驗與成品**：`com.example.lab09.chNN` 是**刻意寫壞的實驗變體**，
  `com.example.lab09.shop` 才是本站建議的樣子（每章最後的「shop-service 落地」小節）。
- **每個實驗變體一個 `@Profile`**（00 章 0.3.0.1）：同章的變體常定義同名 bean
  （`chain`、`passwordEncoder`、`authenticationManager`），不隔離就 `BeanDefinitionOverrideException`。
  測試用 `@ActiveProfiles` 指定跑哪一個。**讀者自己的專案只有一組設定，不需要這樣做。**
- **跨站引用**寫成「04 站 07 章 7.9」，站內引用寫成「01 章 1.7.3」。

## 產出

替訂單系統加上完整的**帳號 / 角色 / 權限體系**：
JWT 登入與續期、方法層權限控管（買家只能看自己的訂單、管理員可看全部）、
稽核日誌，以及一份帶身分的整合測試與上線安全檢查清單。
