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
| 04 | `04-session-vs-stateless-and-csrf.md` | Session 與無狀態 | Session 機制與固定攻擊防護、CSRF 原理與何時可關、有狀態 vs 無狀態的取捨 |
| 05 | `05-jwt-authentication.md` | JWT 認證（核心章） | JWT 結構與簽章、自訂驗證過濾器、過期與 refresh token、撤銷與黑名單、常見錯誤用法 |
| 06 | `06-oauth2-and-social-login.md` | OAuth2 / OIDC | 授權碼流程、`oauth2Login` 第三方登入、Resource Server 驗證、與自家帳號綁定 |
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

## 目前進度

| 章節 | 狀態 |
|------|------|
| 00 課程地圖與安全基礎 | ✅ 可讀（2,865 行，26 個程式碼類別已編譯驗證） |
| 01 架構與 Filter Chain | ✅ 可讀（2,995 行，27 個程式碼類別已編譯驗證） |
| 02 認證機制 | ✅ 可讀（6,459 行，**38 個實測**，58 個程式碼類別已編譯驗證） |
| 03 授權與權限模型 | ✅ 可讀（6,186 行，**46 個實測**，58 個程式碼類別已編譯驗證） |
| 04～08 | ⏳ 未開始 |

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
