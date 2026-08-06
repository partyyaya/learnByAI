import { api } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { ErrorState, Spinner } from "../components/StateBlock";
import { StatusBadge } from "../components/StatusBadge";
import { PERMISSION_LABELS, USER_ROLE, formatDateTime } from "../utils/format";

export function ProfilePage() {
  const { can } = useAuth();
  // 刻意重新問一次伺服器，而不是直接用登入時拿到的 user。
  // 這樣才看得到 session 的簽發與到期時間，也順便驗證 token 還有效。
  const { data, loading, error, reload } = useApi(() => api.get("/auth/me"), []);

  if (loading && !data) return <Spinner label="讀取帳號資訊中…" />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;

  const { user, session } = data;

  return (
    <div className="page page--narrow">
      <section className="card">
        <div className="profile">
          <span className="avatar avatar--lg">{user.name.slice(0, 1)}</span>
          <div>
            <h2 className="profile__name">{user.name}</h2>
            <p className="profile__title">
              {user.title}｜{user.department}
            </p>
            <p className="profile__meta">
              <StatusBadge dictionary={USER_ROLE} value={user.role} />
              <code className="code">{user.account}</code>
              <span>{user.email}</span>
            </p>
          </div>
        </div>
      </section>

      <section className="card">
        <header className="card__head">
          <div>
            <h2 className="card__title">登入狀態</h2>
            <p className="card__subtitle">token 只存在記憶體，重新載入頁面就要重新登入</p>
          </div>
        </header>

        <dl className="detail-list">
          <div>
            <dt>簽發時間</dt>
            <dd>{formatDateTime(session.issuedAt)}</dd>
          </div>
          <div>
            <dt>到期時間</dt>
            <dd>{formatDateTime(session.expiresAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <header className="card__head">
          <div>
            <h2 className="card__title">這個角色能做什麼</h2>
            <p className="card__subtitle">前端據此隱藏按鈕，後端會再擋一次（403）</p>
          </div>
        </header>

        <ul className="permission-list">
          {Object.entries(PERMISSION_LABELS).map(([key, label]) => (
            <li key={key} className={can(key) ? "is-allowed" : "is-denied"}>
              <span aria-hidden="true">{can(key) ? "✓" : "✕"}</span>
              {label}
              <span className="sr-only">{can(key) ? "：允許" : "：不允許"}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
