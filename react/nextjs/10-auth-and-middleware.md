# 第 10 章：認證與 Middleware

## 本章目標

完成這一章後，你應該可以：

1. 用 `middleware.js` 在請求進入頁面前攔截、判斷、轉址。
2. 用 `matcher` 精準控制 middleware 只在哪些路徑跑。
3. 用 cookie 記住登入狀態（`httpOnly`）。
4. 用 Server Action 做登入 / 登出。
5. 在 Server Component 讀取登入者，做路由守衛。
6. 知道正式專案該用 Auth.js（NextAuth）取代自刻。

---

## 1. Middleware：在頁面前面的守門員

`middleware.js` 放在**專案根目錄**（和 `app/` 同層；建專案時若選了 `src/`，就放在 `src/` 裡），會在每個符合條件的請求**進入頁面之前**先執行。最常見用途：檢查登入、轉址、加 header。

```js
// middleware.js
import { NextResponse } from "next/server";

export function middleware(request) {
  const token = request.cookies.get("token")?.value;

  // 沒登入卻想進 /dashboard → 轉去登入頁
  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next(); // 放行
}

// 只在這些路徑跑 middleware
export const config = {
  matcher: ["/dashboard/:path*"],
};
```

重點：

> Next.js 15 的 middleware 預設跑在 **Edge runtime**：一個精簡的執行環境，只有 `fetch`、`Request`、`URL` 這類 Web 標準 API，沒有 `fs` 等 Node.js 專屬功能，第 9 章的 Prisma 也不能在這裡用。所以**不要**在裡面查資料庫或做重運算，它只適合「快速判斷 + 轉址」。真正的權限細節留給頁面本身。（15.5 起可以在 `config` 加 `runtime: "nodejs"` 改跑 Node.js，但它會在每個符合 matcher 的請求前執行，一樣要保持輕量。）

> **版本提醒**：Next.js 16 把 `middleware.js` 改名為 `proxy.js`、匯出的函式改叫 `proxy`，並固定跑在 Node.js runtime；觀念和 `matcher` 寫法都一樣。本課以 Next.js 15 為準，照用 `middleware.js` 即可。

---

## 2. matcher：控制在哪跑

`config.matcher` 決定 middleware 套用的路徑：

```js
export const config = {
  matcher: [
    "/dashboard/:path*", // /dashboard 及其子路徑
    "/settings/:path*",
  ],
};
```

沒寫 matcher 的話會套用到所有請求（含靜態資源），通常不是你要的，記得限定範圍。以上面的 middleware 為例，沒限定範圍時連 `/login` 本身也會被攔下、再轉去 `/login`，變成無限轉址（瀏覽器顯示「重新導向次數過多」）。

---

## 3. 用 cookie 記住登入

登入成功後，把一個 token 寫進 **httpOnly cookie**（JS 讀不到，較安全）：

```jsx
import { cookies } from "next/headers";

const cookieStore = await cookies(); // Next.js 15：要 await
cookieStore.set("token", "使用者的 session token", {
  httpOnly: true,   // 前端 JS 讀不到，防 XSS 竊取
  secure: process.env.NODE_ENV === "production", // 正式環境只走 https；本機 http 開發時不加
  sameSite: "lax",  // 從別的網站發出的 POST、fetch 不會帶上它，擋掉大部分 CSRF
  path: "/",
  maxAge: 60 * 60 * 24, // 一天
});
```

登出就刪掉它：`cookieStore.delete("token")`。

`set()`、`delete()` 只能在 Server Action 或 Route Handler 裡呼叫；Server Component 渲染時只能讀 cookie，在那裡寫入會報錯。

> 本章為了教學，token 用簡單字串示範，middleware 和頁面也只檢查「cookie 在不在、內容是什麼」——任何人在瀏覽器 DevTools 自己加一個 `token=user:admin` 的 cookie 就能冒充 admin。正式環境請用**簽章過的 session**（如 JWT 或 Auth.js 的加密 session），讓伺服器驗得出 cookie 是不是自己發的、有沒有被改過。

---

## 4. 登入 / 登出用 Server Action

```jsx
// app/login/actions.js
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const USER = { username: "admin", password: "admin123" };

export async function login(prevState, formData) {
  const username = formData.get("username");
  const password = formData.get("password");

  if (username !== USER.username || password !== USER.password) {
    return { error: "帳號或密碼錯誤" };
  }

  const cookieStore = await cookies();
  cookieStore.set("token", `user:${username}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  redirect("/dashboard"); // 登入成功轉址
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete("token");
  redirect("/login");
}
```

`login` 是 `(prevState, formData)` 的簽名，因為登入頁要用 `useActionState` 顯示錯誤（第 8 章）。`redirect()` 和第 6 章的 `notFound()` 一樣，是靠丟出 Next.js 專用的例外來中斷執行並轉址，所以它後面的程式不會跑；也**不要把它放進 `try/catch`**，否則會被 `catch` 吃掉、轉址就失效。需要 try/catch 時，把 `redirect()` 放在 try/catch 區塊之後。

---

## 5. 在 Server Component 讀登入者

Middleware 擋掉未登入者，頁面裡再讀 cookie 拿到目前使用者，做更細的顯示或授權：

```jsx
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) return null;
  return { username: token.replace("user:", "") }; // 示範：從 token 解析
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login"); // 第二道防護：不只靠 middleware
  return <h1>歡迎，{user.username}</h1>;
}
```

> **雙層防護**：Middleware 做第一道快速攔截（沒 cookie 直接轉走），頁面/Server Action 再做第二道確認。不要只靠 middleware，也不要只靠頁面。Server Action 尤其要注意：它等同公開的 POST 端點（第 8 章），請求不一定會經過你在 matcher 裡守的那條路徑，所以每個需要登入的 action 開頭都要自己檢查一次（blog-demo 用 `lib/auth.js` 的 `requireUser()` 做這件事）。

---

## 6. 正式專案：用 Auth.js（NextAuth）

自刻 cookie 適合學習與簡單站台。正式專案建議用 **Auth.js（next-auth）**，它幫你處理：

- OAuth（Google / GitHub 登入）、Email、憑證多種方式
- 加密 session、CSRF 防護、token 續期
- `auth()` 一行拿到 session

最小概念：

```bash
npm install next-auth
```

設定 provider 後，用 `auth()` 在 Server Component 拿 session、用 middleware 保護路由。注意 `auth()` 是 Auth.js v5 的 API（套件名稱仍是 `next-auth`），v4 的寫法不同，安裝時要確認裝到的是哪一版。細節依當時 Auth.js 版本文件為準；本課用自刻版把原理講清楚，你之後換 Auth.js 會很快。

---

## 7. 本章小練習

1. 做 `/login` 表單，用 Server Action 驗證 `admin/admin123` 並寫 cookie。
2. 做 `middleware.js`，未登入者進 `/dashboard` 一律轉到 `/login`。
3. `/dashboard` 顯示目前登入者名稱，並放一個「登出」按鈕。
4. 登出後再進 `/dashboard`，確認被擋回登入頁。

---

## 最後範例：登入 + 路由守衛

> 四個檔案組成完整登入流程：middleware 守 `/dashboard`、Server Action 登入登出、儀表板顯示使用者。原樣建立即可跑。

### `middleware.js`（專案根目錄）

```js
import { NextResponse } from "next/server";

export function middleware(request) {
  const token = request.cookies.get("token")?.value;
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"], // 只守後台
};
```

### `app/login/actions.js`

```jsx
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const USER = { username: "admin", password: "admin123" };

export async function login(prevState, formData) {
  const username = formData.get("username");
  const password = formData.get("password");

  if (username !== USER.username || password !== USER.password) {
    return { error: "帳號或密碼錯誤" };
  }

  const cookieStore = await cookies();
  cookieStore.set("token", `user:${username}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  redirect("/dashboard");
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete("token");
  redirect("/login");
}
```

### `app/login/page.js`

```jsx
"use client";
import { useActionState } from "react";
import { login } from "./actions";

export default function LoginPage() {
  const [state, formAction] = useActionState(login, { error: null });

  return (
    <main className="auth">
      <form action={formAction} className="auth-card">
        <h1>登入</h1>
        <input name="username" placeholder="帳號（admin）" />
        <input name="password" type="password" placeholder="密碼（admin123）" />
        <button type="submit">登入</button>
        {state?.error && <p className="err">{state.error}</p>}
      </form>
    </main>
  );
}
```

### `app/dashboard/page.js`

```jsx
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logout } from "../login/actions";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/login"); // 第二道防護：不只靠 middleware
  const username = token.replace("user:", "");

  return (
    <main className="auth">
      <div className="auth-card">
        <h1>後台儀表板</h1>
        <p>歡迎回來，<strong>{username}</strong>！</p>
        <form action={logout}>
          <button type="submit">登出</button>
        </form>
      </div>
    </main>
  );
}
```

### 樣式（加進 `app/globals.css`）

```css
.auth { min-height: 100vh; display: grid; place-items: center; font-family: sans-serif; background: #f3f4f6; }
.auth-card { display: flex; flex-direction: column; gap: 10px; background: #fff; padding: 28px; border-radius: 16px; width: min(360px, 90vw); box-shadow: 0 10px 30px rgba(0,0,0,.08); }
.auth-card input { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; }
.auth-card button { padding: 10px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
.err { color: #dc2626; margin: 0; }
```

---

## 本章結語

你已經能用 middleware + cookie 做出登入與路由守衛，並知道正式專案該進到 Auth.js。  
資料與權限都齊了，接下來三章把「賣相」做好——下一章談樣式、字型與圖片優化。
