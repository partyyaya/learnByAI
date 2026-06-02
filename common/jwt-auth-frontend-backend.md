# 前後端 JWT 登入與加密實戰

> 從原理到實作，完整搞懂 JWT 登入機制：簽章與加密的差異、密碼雜湊、Token 流程、前後端整合，以及一定要避開的安全陷阱。

---

## 0 開始之前：先釐清「加密」這件事

很多人講「JWT 登入加密」，但其實一個登入流程牽涉到**三種不同的安全機制**，混在一起常常誤解。先把它們分開：

| 機制 | 用途 | 技術 | 是否「加密」 |
|------|------|------|--------------|
| 傳輸加密 | 防止封包在網路上被竊聽／竄改 | HTTPS（TLS） | ✅ 真正的加密 |
| 密碼保護 | 資料庫外洩時，密碼不被還原 | bcrypt / argon2（**雜湊**，不可逆） | ❌ 是雜湊不是加密 |
| 身分憑證 | 證明「你已經登入過」 | JWT（**簽章**，可被任何人讀取內容） | ❌ 預設是簽章不是加密 |

> ⚠️ **最重要的觀念（先記起來）**：標準的 JWT **不是加密**，它只是「被簽名」。任何人攔截到 Token 都能解出裡面的內容（payload）。
> 所以 **Token 裡絕對不能放密碼、信用卡號等敏感資料**。如果真的需要加密 payload，要用 JWE（後面 §9 會講）。

JWT 保證的是「**這份內容沒有被竄改**」，而不是「**這份內容沒人看得到**」。

---

## 1 認證（Authentication）vs 授權（Authorization）

```
Authentication（認證）：你是誰？        → 登入、驗證身分
Authorization （授權）：你能做什麼？    → 權限、角色控制
```

- **登入**屬於認證：使用者輸入帳號密碼，伺服器確認身分。
- **每次後續請求**屬於授權：使用者帶著「我已經登入過」的憑證，伺服器判斷他能不能存取某資源。

JWT 解決的核心問題是：**登入成功後，如何在無狀態（stateless）的 HTTP 之上，讓伺服器記得「這個人已經登入了」？**

---

## 2 為什麼需要 Token？Session vs Token

HTTP 是無狀態的，伺服器預設不會記住上一個請求。要維持登入狀態，傳統有兩種做法：

### 2.1 Session（伺服器端記憶）

```
登入 → 伺服器產生 session 並存在記憶體 / Redis → 回傳 session_id（cookie）
之後每次請求帶 session_id → 伺服器查表確認身分
```

| 優點 | 缺點 |
|------|------|
| 可隨時讓單一 session 失效（直接刪除） | 伺服器要儲存所有 session（佔資源） |
| 內容不外洩 | 多台伺服器要共享 session（需 Redis 或 sticky session） |
| 機制簡單成熟 | 水平擴展較麻煩 |

### 2.2 Token（JWT，自我描述的憑證）

```
登入 → 伺服器簽發一個 JWT（內含使用者資訊 + 簽章）→ 回傳給前端
之後每次請求帶 JWT → 伺服器只要「驗證簽章」即可，不需查表
```

| 優點 | 缺點 |
|------|------|
| 伺服器**無狀態**，天生適合水平擴展 | 簽發後在過期前難以主動撤銷 |
| 跨服務 / 跨網域好用（微服務、SSO） | Token 較大，每次請求都要帶 |
| 行動 App、第三方 API 友善 | payload 可被讀取，不能放機密 |

> 沒有銀彈。**需要即時撤銷、單一網站** → Session 往往更省心；**微服務、跨網域、App** → JWT 更靈活。實務上常兩者混用（短效 JWT + 伺服器端 refresh token 記錄）。

---

## 3 JWT 的結構

一個 JWT 是三段用 `.` 連接的字串：

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJuYW1lIjoiQWxpY2UifQ.SflKxw...
└────────── Header ──────────┘ └────────── Payload ──────────┘ └─ Signature ─┘
```

```
Header.Payload.Signature
   │       │         │
   │       │         └── 簽章：用 secret 對「Header.Payload」算出來，用來驗證沒被竄改
   │       └──────────── 內容：使用者 id、角色、過期時間…（Base64Url 編碼，可讀！）
   └──────────────────── 標頭：使用的演算法（alg）與類型（typ）
```

### 3.1 Header

```json
{
  "alg": "HS256",   // 簽章演算法
  "typ": "JWT"
}
```

### 3.2 Payload（Claims，宣告）

Payload 裝的是「宣告（claims）」。有幾個 RFC 7519 定義的標準欄位：

| 欄位 | 全名 | 用途 |
|------|------|------|
| `sub` | Subject | 主體，通常放使用者 ID |
| `iss` | Issuer | 簽發者 |
| `aud` | Audience | 接收對象 |
| `exp` | Expiration | 過期時間（Unix timestamp，**必填**） |
| `iat` | Issued At | 簽發時間 |
| `nbf` | Not Before | 在此時間前不可用 |
| `jti` | JWT ID | 此 Token 的唯一識別碼（可用於撤銷） |

```json
{
  "sub": "1234",
  "name": "Alice",
  "role": "admin",
  "iat": 1716960000,
  "exp": 1716963600
}
```

> 🔍 **親自驗證一次**：把任何 JWT 的中間那段（Payload）拿去 Base64Url 解碼，就能看到內容。這證明了「Payload 不是加密的」。

```bash
# 用命令列解出 payload（注意：這只是 Base64 解碼，不需要任何密鑰）
echo 'eyJzdWIiOiIxMjM0IiwibmFtZSI6IkFsaWNlIiwicm9sZSI6ImFkbWluIn0' | base64 -d
# 輸出：{"sub":"1234","name":"Alice","role":"admin"}
```

### 3.3 Signature（簽章）— 整個機制的核心

簽章是這樣算出來的（以 HS256 為例）：

```
signature = HMAC-SHA256(
    base64UrlEncode(header) + "." + base64UrlEncode(payload),
    secret   ← 只有伺服器知道的密鑰
)
```

驗證時，伺服器拿收到的 `header.payload` 用**自己的 secret** 重新算一次簽章，比對是否與 Token 上的簽章一致：

```
攻擊者想偽造 → 改了 payload（例如把 role 改成 admin）
            → 但他沒有 secret，算不出正確的新簽章
            → 伺服器驗章失敗 → 拒絕
```

這就是 JWT 防竄改的原理：**改內容很容易，但偽造簽章需要 secret。**

---

## 4 簽章演算法：HS256（對稱）vs RS256（非對稱）

| | HS256（HMAC） | RS256 / ES256（RSA / ECDSA） |
|--|---------------|------------------------------|
| 金鑰 | 單一 secret（簽發與驗證同一把） | 私鑰簽發、公鑰驗證 |
| 適用 | 單一服務、前後端同源 | 微服務、第三方需驗證但不該能簽發 |
| 風險 | secret 要分發給所有驗證方，洩漏即全毀 | 公鑰可公開，私鑰只在簽發端 |
| 效能 | 快 | 較慢（但通常不是瓶頸） |

```
HS256：🔑 同一把鑰匙鎖門與開門
       簽發端與驗證端共用 secret

RS256：🔐 私鑰鎖門（簽）、🔓 公鑰開門（驗）
       Auth Server 用私鑰簽 → 各微服務用公鑰驗（不能簽發新 Token）
```

> **選擇建議**：單體應用、前後端同一個團隊 → HS256 夠用且簡單。多服務、要把驗證權下放但不下放簽發權 → 用 RS256。

---

## 5 完整登入流程（序列圖）

### 5.1 雙 Token 設計：Access Token + Refresh Token

實務上很少只用一個 Token。標準做法是：

- **Access Token**：短效（如 15 分鐘），帶在每個 API 請求裡。
- **Refresh Token**：長效（如 7~30 天），只用來「換新的 Access Token」。

```
┌─────────┐                          ┌─────────┐                  ┌──────────┐
│ 前端     │                          │ 後端 API │                  │ 資料庫    │
└────┬────┘                          └────┬────┘                  └────┬─────┘
     │  ① POST /login {帳號, 密碼}        │                            │
     │ ────────────────────────────────> │                            │
     │                                   │  ② 查使用者 + bcrypt 驗密碼 │
     │                                   │ ──────────────────────────>│
     │                                   │ <──────────────────────────│
     │  ③ 簽發 access + refresh token    │                            │
     │ <──────────────────────────────── │                            │
     │                                   │                            │
     │  ④ GET /profile                  │                            │
     │     Authorization: Bearer <AT>    │                            │
     │ ────────────────────────────────> │                            │
     │                                   │  ⑤ 驗證簽章 + exp（無需查表） │
     │  ⑥ 回傳資料                        │                            │
     │ <──────────────────────────────── │                            │
     │                                   │                            │
     │  ⑦ AT 過期 → POST /refresh {RT}   │                            │
     │ ────────────────────────────────> │                            │
     │                                   │  ⑧ 驗 RT（並檢查是否被撤銷）  │
     │  ⑨ 回傳新的 access token           │                            │
     │ <──────────────────────────────── │                            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6 後端實作（Node.js + Express）

以下用最常見的 `jsonwebtoken` + `bcrypt` 示範。其他語言（Java `jjwt`、Python `pyjwt`、Go `golang-jwt`）原理完全一致。

### 6.1 安裝與環境設定

```bash
npm install express jsonwebtoken bcryptjs cookie-parser dotenv
```

```ini
# .env — 千萬不要把 secret 寫死在程式碼裡，也不要進版控
JWT_ACCESS_SECRET=用至少 32 字元的隨機字串_例如用 openssl rand -hex 32 產生
JWT_REFRESH_SECRET=另一把不同的隨機字串
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=7d
```

```bash
# 產生安全的隨機 secret
openssl rand -hex 32
```

### 6.2 密碼雜湊（註冊時）— 為什麼用 bcrypt 而非 SHA256

```js
const bcrypt = require("bcryptjs");

// 註冊：把密碼「加鹽雜湊」後再存。資料庫永遠不存明文密碼。
async function register(username, plainPassword) {
  const saltRounds = 12;                    // 成本因子，越高越慢也越安全
  const passwordHash = await bcrypt.hash(plainPassword, saltRounds);
  await db.users.insert({ username, passwordHash });
}
```

> **為什麼不用 SHA256？** SHA256 太快了，攻擊者可以每秒嘗試數十億次。bcrypt / argon2 是**刻意設計得很慢**且**自帶鹽（salt）**，能抵抗暴力破解與彩虹表。密碼保護要的是「慢」，不是「快」。

### 6.3 簽發 Token 的工具函式

```js
const jwt = require("jsonwebtoken");

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },        // payload：只放非機密的識別資訊
    process.env.JWT_ACCESS_SECRET,
    {
      expiresIn: process.env.ACCESS_TOKEN_TTL, // 短效
      issuer: "my-app",
      audience: "my-app-client",
    }
  );
}

function signRefreshToken(user, tokenId) {
  return jwt.sign(
    { sub: user.id, jti: tokenId },           // jti：用於日後撤銷
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_TTL }
  );
}
```

### 6.4 登入 endpoint

```js
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const app = express();
app.use(express.json());

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  // ① 查使用者
  const user = await db.users.findByUsername(username);

  // ② 驗證密碼。注意：找不到使用者與密碼錯誤要回「相同的錯誤訊息」，
  //    避免攻擊者用回應差異判斷帳號是否存在（帳號列舉攻擊）。
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) {
    return res.status(401).json({ message: "帳號或密碼錯誤" });
  }

  // ③ 簽發 access + refresh token
  const accessToken = signAccessToken(user);
  const tokenId = crypto.randomUUID();
  const refreshToken = signRefreshToken(user, tokenId);

  // ④ 把 refresh token 的 id 存到資料庫（之後可用來撤銷）
  await db.refreshTokens.save({ tokenId, userId: user.id, valid: true });

  // ⑤ refresh token 放進 httpOnly cookie（JS 讀不到 → 防 XSS 竊取）
  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: true,            // 只在 HTTPS 傳送
    sameSite: "strict",      // 防 CSRF
    path: "/api/refresh",    // 只在 refresh 端點才送出，縮小暴露面
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  // ⑥ access token 回傳給前端（前端存記憶體）
  res.json({ accessToken });
});
```

### 6.5 驗證 middleware（保護需要登入的 API）

```js
const jwt = require("jsonwebtoken");

function authGuard(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "未提供 Token" });

  try {
    // verify 會同時檢查：簽章正確 + 未過期 + iss/aud 相符
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
      issuer: "my-app",
      audience: "my-app-client",
      algorithms: ["HS256"],   // ⚠️ 一定要明確指定！見 §8 演算法混淆攻擊
    });
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token 已過期", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ message: "Token 無效" });
  }
}

// 使用
app.get("/api/profile", authGuard, (req, res) => {
  res.json({ userId: req.user.id, role: req.user.role });
});

// 角色授權（在認證之上做授權）
function requireRole(role) {
  return (req, res, next) =>
    req.user.role === role ? next() : res.status(403).json({ message: "權限不足" });
}
app.delete("/api/users/:id", authGuard, requireRole("admin"), handler);
```

### 6.6 Refresh endpoint（換新的 access token）

```js
const cookieParser = require("cookie-parser");
app.use(cookieParser());

app.post("/api/refresh", async (req, res) => {
  const token = req.cookies.refresh_token;
  if (!token) return res.status(401).json({ message: "無 refresh token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    // 檢查這個 refresh token 是否已被撤銷（登出 / 強制下線）
    const record = await db.refreshTokens.findById(payload.jti);
    if (!record || !record.valid) {
      return res.status(401).json({ message: "Token 已失效" });
    }

    const user = await db.users.findById(payload.sub);
    const accessToken = signAccessToken(user);
    res.json({ accessToken });
  } catch {
    return res.status(401).json({ message: "refresh token 無效或過期" });
  }
});
```

### 6.7 登出（撤銷 refresh token）

```js
app.post("/api/logout", async (req, res) => {
  const token = req.cookies.refresh_token;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      await db.refreshTokens.invalidate(payload.jti);   // 標記為失效
    } catch { /* 忽略，照樣清 cookie */ }
  }
  res.clearCookie("refresh_token", { path: "/api/refresh" });
  res.json({ message: "已登出" });
});
```

---

## 7 前端實作

### 7.1 關鍵抉擇：Token 要存在哪裡？

這是前端最常被問也最常做錯的地方：

| 存放位置 | XSS 風險 | CSRF 風險 | 說明 |
|----------|----------|-----------|------|
| `localStorage` | ❌ 高 | ✅ 無 | JS 能讀 → 一旦有 XSS，Token 直接被偷 |
| `sessionStorage` | ❌ 高 | ✅ 無 | 同上，且關閉分頁即消失 |
| 一般 Cookie | ❌ 高 | ❌ 高 | JS 可讀 + 自動帶上 → 兩種風險都有 |
| **httpOnly Cookie** | ✅ 低 | ⚠️ 需防護 | JS 讀不到 → 防 XSS 竊取；但需配 `SameSite`/CSRF token 防 CSRF |
| **記憶體（變數）** | ✅ 低 | ✅ 無 | 最安全但重整頁面就消失 |

> **業界推薦的折衷做法**：
> - **Access Token** 放在**記憶體**（JS 變數 / 狀態管理），短效、重整後用 refresh 重新取得。
> - **Refresh Token** 放在 **httpOnly + Secure + SameSite cookie**，JS 碰不到，降低被竊風險。
>
> 這正是 §6 後端範例採用的設計。**避免把長效 Token 放 localStorage**。

### 7.2 登入請求

```js
// api.js
const API = "https://api.example.com";

let accessToken = null;                    // 存在記憶體
export const setAccessToken = (t) => (accessToken = t);
export const getAccessToken = () => accessToken;

export async function login(username, password) {
  const res = await fetch(`${API}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",                // 讓瀏覽器接收 httpOnly cookie
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error("登入失敗");
  const { accessToken: token } = await res.json();
  setAccessToken(token);                   // access token 只存記憶體
  return token;
}
```

### 7.3 用 Axios 攔截器自動帶 Token + 自動 Refresh

`axios` 的 interceptor 能讓你不必在每支 API 手動加 Token，並在收到 401 時自動 refresh 後重送。

```js
import axios from "axios";
import { getAccessToken, setAccessToken } from "./api";

const http = axios.create({
  baseURL: "https://api.example.com",
  withCredentials: true,                   // 帶上 httpOnly cookie
});

// ① 請求攔截器：自動把 access token 放進 Authorization
http.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ② 回應攔截器：遇到 401 自動 refresh 後重送原請求
let refreshing = null;                      // 用來避免同時多個請求重複 refresh

http.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retried) {
      original._retried = true;
      try {
        // 多個請求同時 401 時，共用同一個 refresh Promise
        refreshing = refreshing || http.post("/api/refresh");
        const { data } = await refreshing;
        refreshing = null;
        setAccessToken(data.accessToken);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return http(original);              // 帶新 token 重送
      } catch (e) {
        refreshing = null;
        setAccessToken(null);
        window.location.href = "/login";    // refresh 也失敗 → 回登入頁
        return Promise.reject(e);
      }
    }
    return Promise.reject(error);
  }
);

export default http;
```

### 7.4 重整頁面後恢復登入狀態

因為 access token 只放記憶體，重整後會消失。利用 httpOnly 的 refresh cookie，在 App 啟動時靜默換一張新的 access token：

```js
// App 啟動時呼叫一次
export async function bootstrapAuth() {
  try {
    const { data } = await http.post("/api/refresh");  // 瀏覽器自動帶 refresh cookie
    setAccessToken(data.accessToken);
    return true;                                        // 已登入
  } catch {
    return false;                                       // 未登入 → 導向登入頁
  }
}
```

### 7.5 React 範例：保護路由

```jsx
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { bootstrapAuth, getAccessToken } from "./api";

function RequireAuth({ children }) {
  const [status, setStatus] = useState("loading"); // loading | authed | guest

  useEffect(() => {
    if (getAccessToken()) return setStatus("authed");
    bootstrapAuth().then((ok) => setStatus(ok ? "authed" : "guest"));
  }, []);

  if (status === "loading") return <p>載入中…</p>;
  if (status === "guest") return <Navigate to="/login" replace />;
  return children;
}

// 使用：<Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
```

---

## 8 安全最佳實踐與常見攻擊

### 8.1 一定要遵守的清單

```
✅ 全程 HTTPS：JWT 是明文可讀的，沒有 HTTPS 等於把 Token 攤在陽光下
✅ Access Token 短效（5~15 分鐘）+ Refresh Token 機制
✅ verify 時明確指定 algorithms（防演算法混淆，見 §8.2）
✅ 一定要驗 exp（過期時間），最好也驗 iss / aud
✅ secret 夠長夠隨機（≥32 bytes），放環境變數，不進版控
✅ Refresh Token 存 httpOnly + Secure + SameSite cookie
✅ payload 不放任何敏感資料（密碼、卡號、身分證…）
✅ 登入失敗訊息模糊化，避免帳號列舉
✅ 重要操作（改密碼、轉帳）即使有 Token 仍要二次驗證
```

### 8.2 經典攻擊 1：`alg: none` 與演算法混淆

```
攻擊手法 A — alg: none
  攻擊者把 header 改成 {"alg":"none"}，宣稱「這個 Token 不需要簽章」
  → 若後端照單全收，等於不驗章 → 任意偽造！

攻擊手法 B — RS256 降級成 HS256
  系統用 RS256（公鑰驗證），但公鑰是公開的
  攻擊者把 alg 改成 HS256，並「用那把公開的公鑰當作 HMAC secret」去簽
  → 若後端沒鎖定演算法，會用公鑰去做 HMAC 驗證 → 驗證通過！
```

**防禦**：呼叫 `verify` 時**永遠明確指定允許的演算法**，不要相信 Token header 裡的 `alg`：

```js
// ✅ 正確
jwt.verify(token, secret, { algorithms: ["HS256"] });

// ❌ 危險：未限制，攻擊者可指定 none 或降級
jwt.verify(token, secret);
```

### 8.3 經典攻擊 2：XSS 竊取 Token

若 Token 放在 `localStorage`，任何被注入的惡意腳本（XSS）都能 `localStorage.getItem("token")` 偷走。

**防禦**：Refresh Token 放 httpOnly cookie（JS 讀不到）；Access Token 放記憶體且短效；同時做好輸出轉義、CSP 等 XSS 防護。

### 8.4 經典攻擊 3：CSRF（針對 cookie）

當憑證放在 cookie，瀏覽器會在跨站請求時自動帶上，攻擊者可誘導使用者的瀏覽器發出非預期請求。

**防禦**：
- Cookie 設 `SameSite=Strict`（或 `Lax`），阻擋大多數跨站自動帶送。
- 搭配 CSRF Token（double-submit）或自訂 header 驗證。
- Refresh cookie 限定 `path=/api/refresh`，縮小暴露面。

### 8.5 撤銷問題：JWT 簽出去就難以收回

JWT 無狀態的代價是「沒辦法像 session 一樣直接刪掉」。常見解法：

| 策略 | 做法 | 取捨 |
|------|------|------|
| 短效 Access Token | 過期就自動失效，最多撐 15 分鐘 | 最簡單，多數情境足夠 |
| Refresh Token 白/黑名單 | 在 DB 記錄 `jti`，撤銷時標記失效 | 需查表，但只在 refresh 時 |
| Token 版本號 | user 表存 `tokenVersion`，改密碼時 +1，payload 帶版本比對 | 可一次登出該使用者所有裝置 |

```js
// Token 版本號做法：登出所有裝置 / 改密碼後讓舊 Token 全失效
// 簽發時：payload 帶 ver: user.tokenVersion
// 驗證時：
if (payload.ver !== user.tokenVersion) {
  return res.status(401).json({ message: "Token 已失效，請重新登入" });
}
```

---

## 9 真的需要「加密」payload 時：JWE

回到開頭的觀念：標準 JWT（其實叫 JWS，JSON Web Signature）只簽章不加密。如果你的 payload **真的**含有不能被讀取的內容，就要用 **JWE（JSON Web Encryption）**。

```
JWS（一般 JWT）：簽章但可讀         → 防竄改，不防偷看
JWE          ：內容加密，看不到     → 防竄改 + 防偷看（payload 是密文）
```

```js
// 用 jose 套件做 JWE（A256GCM 對稱加密）
import { EncryptJWT, jwtDecrypt } from "jose";

const secret = new Uint8Array(32); // 實務上用 crypto.randomBytes(32)

// 加密簽發
const jwe = await new EncryptJWT({ ssn: "A123456789" })
  .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
  .setExpirationTime("15m")
  .encrypt(secret);

// 解密驗證
const { payload } = await jwtDecrypt(jwe, secret);
```

> 但大多數情況下，**正確答案不是加密 payload，而是「一開始就不要把機密放進 Token」**。Token 只放 `userId`、`role` 這類識別資訊，需要機密資料時再用這個 id 去後端查。

---

## 10 常見問題 FAQ

**Q1：JWT 可以用來「加密」資料嗎？**
標準 JWT（JWS）不行，它只簽章、不加密，內容人人可讀。要加密請用 JWE，但更好的做法是不要在 Token 裡放機密。

**Q2：Token 被偷了怎麼辦？**
這就是為什麼 Access Token 要短效。被偷的 Token 最多在過期前可用。Refresh Token 則放 httpOnly cookie 降低被竊機率，並可在伺服器端撤銷。

**Q3：為什麼登入要回兩個 Token？只用一個不行嗎？**
可以，但要取捨：Token 設太長 → 被偷風險大且難撤銷；設太短 → 使用者一直要重登。雙 Token 同時兼顧安全（短效 AT）與體驗（長效 RT 自動續期）。

**Q4：JWT 該設多長的過期時間？**
Access Token 一般 5~15 分鐘；Refresh Token 數天到數週。視敏感程度調整：金融類更短、一般內容類可長一些。

**Q5：前後端不同網域（CORS）怎麼帶 cookie？**
後端需設 `Access-Control-Allow-Credentials: true` 且 `Access-Control-Allow-Origin` 指定明確網域（不可用 `*`）；前端 fetch 加 `credentials: "include"`、axios 設 `withCredentials: true`。

**Q6：密碼是用 JWT 加密儲存的嗎？**
不是。密碼用 bcrypt/argon2 **雜湊**（不可逆）後存資料庫，與 JWT 完全無關。JWT 是登入「之後」的身分憑證。

---

## 11 總結

```
登入加密的完整圖像：

  傳輸層   → HTTPS（TLS）真正加密封包，全程必備
  密碼     → bcrypt/argon2 雜湊，資料庫不存明文
  身分憑證 → JWT 簽章（非加密！），防竄改
             ├── Access Token：短效、放記憶體、帶在 Authorization header
             └── Refresh Token：長效、放 httpOnly cookie、可撤銷
  機密 payload（少見）→ 需要時才用 JWE，但更建議「別把機密放進 Token」
```

記住三個核心觀念，就不會用錯 JWT：

1. **JWT 是簽章不是加密** — payload 人人可讀，別放機密。
2. **無狀態是優點也是代價** — 好擴展，但難即時撤銷，所以要短效 + refresh。
3. **存放位置決定安全性** — Access Token 放記憶體、Refresh Token 放 httpOnly cookie，遠離 localStorage。

---

> 延伸閱讀：
> - [第一章：HTTP 與 HTTPS 必備知識](./01-http-https.md) — JWT 必須跑在 HTTPS 之上
> - [第二章：SSL 憑證](./02-ssl-certificates.md) — 傳輸加密的基礎
> - [Promise、async/await](./promise-async-await-then.md) — 前端 Token refresh 流程都是非同步
