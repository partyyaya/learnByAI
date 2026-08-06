import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi, useMutation } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { ErrorState, Spinner } from "../components/StateBlock";
import { IconAlert, IconRefresh } from "../components/icons";

/**
 * 系統設定 ／ 模擬後端：調整延遲、失敗率與斷線。
 * 改完之後所有 API 都會受影響，用來測「載入中 / 失敗 / 連不到」時的畫面。
 */
export function MockConfigPage() {
  const { can } = useAuth();
  const toast = useToast();

  const { data, loading, error, reload } = useApi(() => api.get("/system/mock-config"), []);
  const [form, setForm] = useState(null);

  // 伺服器的值回來（或按了重設之後重新載入）就同步到表單。
  // 表單另外存一份，是為了讓使用者可以拉一半再放棄，不會每動一下就送請求。
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const { run: save, pending: saving } = useMutation(async (next) => {
    try {
      const applied = await api.put("/system/mock-config", next);
      setForm(applied);
      toast.success("模擬參數已套用");
    } catch (apiError) {
      toast.error(apiError.message);
    }
  });

  const update = (key) => (event) => {
    const raw = event.target.type === "checkbox" ? event.target.checked : Number(event.target.value);
    setForm((prev) => ({ ...prev, [key]: raw }));
  };

  return (
    <div className="page page--narrow">
      <section className="card">
        <header className="card__head">
          <div>
            <h2 className="card__title">模擬後端參數</h2>
            <p className="card__subtitle">
              調整之後所有 API 都會受影響，用來測試載入中、失敗與斷線時的畫面
            </p>
          </div>
          <button type="button" className="btn btn--ghost btn--compact" onClick={reload} disabled={loading}>
            <IconRefresh size={16} />
            重新讀取
          </button>
        </header>

        {error && !form ? <ErrorState error={error} onRetry={reload} /> : null}
        {!form && loading ? <Spinner label="讀取設定中…" /> : null}

        {form ? (
          <>
            <div className="settings-grid">
              <label className="field">
                <span className="field__label">
                  最短延遲 <em>{form.minLatencyMs} ms</em>
                </span>
                <input
                  type="range"
                  min="0"
                  max="3000"
                  step="20"
                  value={form.minLatencyMs}
                  onChange={update("minLatencyMs")}
                />
              </label>

              <label className="field">
                <span className="field__label">
                  最長延遲 <em>{form.maxLatencyMs} ms</em>
                </span>
                <input
                  type="range"
                  min="0"
                  max="3000"
                  step="20"
                  value={form.maxLatencyMs}
                  onChange={update("maxLatencyMs")}
                />
              </label>

              <label className="field">
                <span className="field__label">
                  隨機失敗率 <em>{Math.round(form.failureRate * 100)}%</em>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={form.failureRate}
                  onChange={update("failureRate")}
                />
                <span className="field__note">登入不受影響，否則設高了就登不進來</span>
              </label>

              <label className="field field--switch">
                <input type="checkbox" checked={form.offline} onChange={update("offline")} />
                <span>
                  <strong>模擬斷線</strong>
                  <small>所有請求都回 status 0，就像連不到伺服器</small>
                </span>
              </label>
            </div>

            {form.maxLatencyMs < form.minLatencyMs ? (
              <p className="alert alert--warning">
                <IconAlert size={16} />
                最長延遲小於最短延遲，套用時伺服器會自動把它拉到一樣的值
              </p>
            ) : null}

            <div className="card__actions">
              <button type="button" className="btn btn--ghost" onClick={reload} disabled={saving}>
                放棄變更
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => save(form)}
                disabled={saving || !can("system.write")}
                title={can("system.write") ? undefined : "唯讀帳號不能修改設定"}
              >
                {saving ? <Spinner label="套用中…" /> : "套用設定"}
              </button>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
