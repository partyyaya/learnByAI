import { useState } from "react";
import { api } from "../api/client";
import { IconPower } from "../components/icons";

/**
 * 系統設定 ／ 連線測試：手動打幾支 API，觀察成功與失敗時前端怎麼反應。
 * 像一個迷你版的 Network 分頁——搭配「模擬後端」那一頁調高失敗率最有感。
 */
export function ProbePage() {
  const [log, setLog] = useState([]);

  function appendLog(entry) {
    // 只留最近 6 筆，不然這一區會愈長愈高
    setLog((list) => [{ id: `${Date.now()}-${list.length}`, ...entry }, ...list].slice(0, 6));
  }

  async function probe(label, call) {
    const startedAt = performance.now();
    try {
      await call();
      appendLog({ label, ok: true, status: 200, elapsed: performance.now() - startedAt });
    } catch (apiError) {
      appendLog({
        label,
        ok: false,
        status: apiError.status,
        message: apiError.message,
        elapsed: performance.now() - startedAt
      });
    }
  }

  return (
    <div className="page page--narrow">
      <section className="card">
        <header className="card__head">
          <div>
            <h2 className="card__title">連線測試</h2>
            <p className="card__subtitle">直接打幾支 API，觀察成功與失敗時前端怎麼反應</p>
          </div>
        </header>

        <div className="probe-buttons">
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            onClick={() => probe("GET /auth/me", () => api.get("/auth/me"))}
          >
            取得目前登入資訊
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            onClick={() => probe("GET /users?page=1", () => api.get("/users", { page: 1, pageSize: 5 }))}
          >
            取得使用者列表
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            onClick={() => probe("GET /not-exist（預期 404）", () => api.get("/not-exist"))}
          >
            打一支不存在的 API
          </button>
          <button
            type="button"
            className="btn btn--danger btn--compact"
            onClick={async () => {
              // 讓 token 立刻過期，下一次任何請求就會 401 →
              // client.js 的 unauthorizedHandler 會把 App 踢回登入頁
              await probe("POST /system/expire-session", () => api.post("/system/expire-session"));
              await probe("GET /auth/me（預期 401）", () => api.get("/auth/me"));
            }}
          >
            <IconPower size={16} />
            讓登入立刻逾期
          </button>
        </div>

        {log.length === 0 ? (
          <p className="probe-empty">按上面的按鈕就會出現呼叫紀錄。</p>
        ) : (
          <ul className="probe-log">
            {log.map((entry) => (
              <li key={entry.id} className={`probe-log__item${entry.ok ? "" : " is-error"}`}>
                <span className={`badge badge--${entry.ok ? "success" : "danger"}`}>
                  {entry.status || "—"}
                </span>
                <code>{entry.label}</code>
                <span className="probe-log__meta">
                  {Math.round(entry.elapsed)} ms
                  {entry.message ? `｜${entry.message}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
