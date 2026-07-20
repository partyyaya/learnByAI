"use server";
import { redirect } from "next/navigation";
import { CREDENTIALS, setSession, clearSession } from "@/lib/auth";

// 登入：接 useActionState 的 (prevState, formData)，回傳錯誤或轉址
export async function loginAction(prevState, formData) {
  const username = formData.get("username");
  const password = formData.get("password");

  if (username !== CREDENTIALS.username || password !== CREDENTIALS.password) {
    return { error: "帳號或密碼錯誤" };
  }

  await setSession(username);
  redirect("/admin"); // 成功後導向後台
}

// 登出：清 cookie 後回登入頁
export async function logoutAction() {
  await clearSession();
  redirect("/login");
}
