"use client";
import { useActionState } from "react";
import { loginAction } from "./actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, { error: null });

  return (
    <main className="auth">
      <form action={formAction} className="auth-card">
        <h1>後台登入</h1>
        <div className="field">
          <label htmlFor="username">帳號</label>
          <input id="username" name="username" defaultValue="admin" />
        </div>
        <div className="field">
          <label htmlFor="password">密碼</label>
          <input id="password" name="password" type="password" defaultValue="admin123" />
        </div>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "登入中…" : "登入"}
        </button>
        {state?.error && <p className="err">{state.error}</p>}
        <p className="hint">測試帳密：admin / admin123</p>
      </form>
    </main>
  );
}
