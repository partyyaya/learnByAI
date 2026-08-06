import { api } from "../api/client";
import { useApi } from "../hooks/useApi";
import { PERMISSIONS, useAuth } from "../context/AuthContext";
import { ErrorState, Spinner } from "../components/StateBlock";
import { StatusBadge } from "../components/StatusBadge";
import { IconRefresh } from "../components/icons";
import { PERMISSION_LABELS, USER_ROLE, formatNumber } from "../utils/format";

const ROLES = ["admin", "editor", "viewer"];
const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS);

/**
 * 使用者管理 ／ 角色與權限。
 *
 * 整張對照表直接畫 AuthContext 的 PERMISSIONS，不另外抄一份——抄了就會有「權限改了
 * 但這一頁還在講舊規則」的那一天。
 */
export function RolesPage() {
  const { user: me } = useAuth();

  // mock 沒有「每個角色幾個人」這支 API，所以三個角色各打一次 /users，只取分頁
  // 資訊裡的 total（pageSize 給最小值 5：要的是數字，不是名單）。三支併發，
  // 任何一支失敗就整頁重試——少一欄數字的對照表比整頁錯誤更難懂。
  const { data, loading, error, reload } = useApi(
    () =>
      Promise.all(ROLES.map((role) => api.get("/users", { role, pageSize: 5 }))).then((results) =>
        Object.fromEntries(ROLES.map((role, index) => [role, results[index].pagination.total]))
      ),
    []
  );

  return (
    <div className="page">
      <section className="card">
        <header className="card__head">
          <div>
            <h2 className="card__title">角色與權限</h2>
            <p className="card__subtitle">
              前端據此隱藏按鈕，後端的 <code className="code">route.roles</code> 會再擋一次（403）
            </p>
          </div>
          <button type="button" className="btn btn--ghost btn--compact" onClick={reload} disabled={loading}>
            <IconRefresh size={16} />
            重新讀取
          </button>
        </header>

        {error && !data ? <ErrorState error={error} onRetry={reload} /> : null}
        {!data && loading ? <Spinner label="統計各角色人數中…" /> : null}

        {data ? (
          <div className="table-wrap table-wrap--plain">
            <table className="table role-matrix">
              <thead>
                <tr>
                  <th scope="col">可以做的事</th>
                  {ROLES.map((role) => (
                    <th key={role} scope="col" className="role-matrix__role">
                      <StatusBadge dictionary={USER_ROLE} value={role} />
                      <small>
                        {formatNumber(data[role])} 個帳號
                        {me?.role === role ? "（你）" : ""}
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_KEYS.map((key) => (
                  <tr key={key}>
                    <th scope="row" className="role-matrix__perm">
                      {PERMISSION_LABELS[key]}
                      <code className="code">{key}</code>
                    </th>
                    {ROLES.map((role) => {
                      const allowed = PERMISSIONS[role].includes(key);
                      return (
                        <td key={role} className="role-matrix__cell">
                          <span className={allowed ? "is-allowed" : "is-denied"} aria-hidden="true">
                            {allowed ? "✓" : "✕"}
                          </span>
                          <span className="sr-only">{allowed ? "允許" : "不允許"}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card">
        <header className="card__head">
          <div>
            <h2 className="card__title">為什麼前後端都要有一份</h2>
          </div>
        </header>

        <ul className="permission-list">
          <li className="is-allowed">
            <span aria-hidden="true">✓</span>
            前端這份（<code className="code">PERMISSIONS</code>）只決定「要不要把按鈕畫出來」
          </li>
          <li className="is-allowed">
            <span aria-hidden="true">✓</span>
            後端那份（<code className="code">server.js</code> 的 <code className="code">route.roles</code>
            ）才是真的擋，回 403
          </li>
          <li className="is-denied">
            <span aria-hidden="true">✕</span>
            只擋前端等於沒擋——IPC 通道是公開的，改一行 devtools 就繞過去了
          </li>
        </ul>
      </section>
    </div>
  );
}
