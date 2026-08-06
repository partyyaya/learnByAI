import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Spinner } from "../components/StateBlock";
import { IconAlert, IconLock, IconUser } from "../components/icons";

// mock 才會有這一區。真的產品當然不會把測試帳號印在登入頁上。
const DEMO_ACCOUNTS = [
  { account: "admin", password: "admin123", label: "系統管理員", note: "可修改、可刪除" },
  { account: "editor", password: "editor123", label: "編輯者", note: "可修改，不能刪除" },
  { account: "viewer", password: "viewer123", label: "唯讀訪客", note: "只能看，操作會被擋（403）" }
];

export function LoginPage() {
  const { login, isAuthenticated, signOutReason, lastAccount } = useAuth();
  const toast = useToast();
  const location = useLocation();

  const [form, setForm] = useState({ account: lastAccount || "admin", password: "" });
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  // 已經登入就不該再看到登入頁。這裡不用 useEffect + navigate，直接在 render
  // 回一個 <Navigate>——前者會先閃一下登入畫面才跳走。
  //
  // state.from 是 RequireAuth 存下來的「原本想去的頁面」，登入後直接回到那裡。
  if (isAuthenticated) {
    return <Navigate to={location.state?.from ?? "/dashboard"} replace />;
  }

  const update = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const user = await login(form);
      toast.success(`歡迎回來，${user.name}`);
      // 不用手動導頁：user 有值之後上面那個 <Navigate> 就會生效
    } catch (apiError) {
      setError(apiError);
      // 密碼留在欄位裡不清掉——被清空最惱人的是「其實只是帳號打錯」
    } finally {
      setPending(false);
    }
  }

  function fillDemo(demo) {
    setForm({ account: demo.account, password: demo.password });
    setError(null);
  }

  return (
    <div className="login">
      <section className="login__intro">
        <span className="login__logo">LB</span>
        <h1>LearnByAI 後台管理系統</h1>
        <p className="login__lede">
          Electron + React 的後台範例。登入之後左邊是側邊欄、上面是導航欄，
          所有資料都來自跑在 main process 裡的模擬後端。
        </p>
        <ul className="login__points">
          <li>登入、權限、分頁、篩選都走同一套 API 介面</li>
          <li>可以自己調延遲、失敗率，甚至模擬斷線</li>
          <li>renderer 沒有 Node.js 權限，全部透過 IPC 取資料</li>
        </ul>
      </section>

      <section className="login__panel">
        <form className="login__card" onSubmit={handleSubmit}>
          <h2>登入</h2>
          <p className="login__hint">請輸入後台帳號密碼</p>

          {/* 被 401 踢出來時告訴使用者原因，不然會以為自己按錯 */}
          {signOutReason && !error ? (
            <p className="alert alert--warning">
              <IconAlert size={16} />
              {signOutReason}
            </p>
          ) : null}

          {error ? (
            <p className="alert alert--danger" role="alert">
              <IconAlert size={16} />
              <span>
                {error.message}
                {error.status ? <em className="alert__code">HTTP {error.status}</em> : null}
              </span>
            </p>
          ) : null}

          <label className="field">
            <span className="field__label">帳號</span>
            <span className="field__control">
              <IconUser size={16} />
              <input
                type="text"
                value={form.account}
                onChange={update("account")}
                autoComplete="username"
                autoFocus
                required
                disabled={pending}
              />
            </span>
          </label>

          <label className="field">
            <span className="field__label">密碼</span>
            <span className="field__control">
              <IconLock size={16} />
              <input
                type="password"
                value={form.password}
                onChange={update("password")}
                autoComplete="current-password"
                required
                disabled={pending}
              />
            </span>
          </label>

          <button type="submit" className="btn btn--primary btn--block" disabled={pending}>
            {pending ? <Spinner label="登入中…" /> : "登入"}
          </button>

          <div className="login__demo">
            <p className="login__demo-title">測試帳號（點一下自動填入）</p>
            {DEMO_ACCOUNTS.map((demo) => (
              <button
                key={demo.account}
                type="button"
                className="login__demo-item"
                onClick={() => fillDemo(demo)}
                disabled={pending}
              >
                <code>
                  {demo.account} / {demo.password}
                </code>
                <span>
                  <strong>{demo.label}</strong>
                  {demo.note}
                </span>
              </button>
            ))}
          </div>
        </form>
      </section>
    </div>
  );
}
