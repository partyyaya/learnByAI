import { requireUser } from "@/lib/auth";
import { logoutAction } from "../login/actions";

// 後台版面：除了 middleware 的第一道防護，這裡再確認一次登入者（雙層防護，第 10 章）
export default async function AdminLayout({ children }) {
  const user = await requireUser();

  return (
    <div className="wrap">
      <div className="admin-header">
        <div>
          <h1 style={{ margin: 0 }}>後台管理</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            登入者：{user.username}
          </p>
        </div>
        <form action={logoutAction}>
          <button className="btn btn-ghost" type="submit">登出</button>
        </form>
      </div>
      {children}
    </div>
  );
}
