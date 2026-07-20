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

`middleware.js` 放在**專案根目錄**（和 `app/` 同層），會在每個符合條件的請求**進入頁面之前**先執行。最常見用途：檢查登入、轉址、加 header。

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

> Middleware 跑在 **Edge 環境**，很輕量。**不要**在裡面查資料庫或做重運算，它只適合「快速判斷 + 轉址」。真正的權限細節留給頁面本身。

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

沒寫 matcher 的話會套用到所有請求（含靜態資源），通常不是你要的，記得限定範圍。

---

## 3. 用 cookie 記住登入

登入成功後，把一個 token 寫進 **httpOnly cookie**（JS 讀不到，較安全）：

```jsx
import { cookies } from "next/headers";

const cookieStore = await cookies(); // Next.js 15：要 await
cookieStore.set("token", "使用者的 session token", {
  httpOnly: true,   // 前端 JS 讀不到，防 XSS 竊取
  secure: true,     // 只在 https 傳（正式環境）
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24, // 一天
});
```

登出就刪掉它：`cookieStore.delete("token")`。

> 本章為了教學，token 用簡單字串示範。正式環境請用**簽章過的 session**（如 JWT 或 Auth.js 的加密 session），不要把可被偽造的明文當憑證。

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

---

## 5. 在 Server Component 讀登入者

Middleware 擋掉未登入者，頁面裡再讀 cookie 拿到目前使用者，做更細的顯示或授權：

```jsx
import { cookies } from "next/headers";

async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) return null;
  return { username: token.replace("user:", "") }; // 示範：從 token 解析
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  return <h1>歡迎，{user?.username}</h1>;
}
```

> **雙層防護**：Middleware 做第一道快速攔截（沒 cookie 直接轉走），頁面/Server Action 再做第二道確認。不要只靠 middleware，也不要只靠頁面。

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

設定 provider 後，用 `auth()` 在 Server Component 拿 session、用 middleware 保護路由。細節依當時 Auth.js 版本文件為準；本課用自刻版把原理講清楚，你之後換 Auth.js 會很快。

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
import { logout } from "../login/actions";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value ?? "";
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
