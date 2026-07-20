// 極簡 cookie 認證輔助（第 10 章）。
// 教學用：token 是明文字串。正式環境請用簽章/加密 session 或 Auth.js。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const TOKEN_NAME = "token";

// demo 帳密
export const CREDENTIALS = { username: "admin", password: "admin123" };

// 讀目前登入者；未登入回 null
export async function getUser() {
  const store = await cookies(); // Next.js 15：cookies() 要 await
  const token = store.get(TOKEN_NAME)?.value;
  if (!token) return null;
  return { username: token.replace("user:", "") };
}

// 頁面/Action 的第二道防護：沒登入就轉去 /login
export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

// 登入成功：寫 httpOnly cookie
export async function setSession(username) {
  const store = await cookies();
  store.set(TOKEN_NAME, `user:${username}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24, // 一天
  });
}

// 登出：清掉 cookie
export async function clearSession() {
  const store = await cookies();
  store.delete(TOKEN_NAME);
}
