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
| 00 | `00-course-map-security-fundamentals.md` | 課程地圖與安全基礎 | 認證 vs 授權、威脅模型、Spring Security 預設幫你擋了什麼 |
| 01 | `01-filter-chain-architecture.md` | 架構與 Filter Chain（核心章） | `SecurityFilterChain` 組成、各 Filter 職責、`SecurityContextHolder`、多條 chain 與比對順序 |
| 02 | `02-authentication-userdetails-password.md` | 認證機制 | `UserDetailsService`、`AuthenticationProvider`、`PasswordEncoder`（BCrypt / Argon2）、表單與 HTTP Basic、自訂登入流程 |
| 03 | `03-authorization-and-method-security.md` | 授權與權限模型 | URL 層規則、`hasRole` vs `hasAuthority`、`@PreAuthorize` / `@PostAuthorize`、RBAC 資料表設計、資料層級權限 |
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

## 產出

替訂單系統加上完整的**帳號 / 角色 / 權限體系**：
JWT 登入與續期、方法層權限控管（買家只能看自己的訂單、管理員可看全部）、
稽核日誌，以及一份帶身分的整合測試與上線安全檢查清單。
