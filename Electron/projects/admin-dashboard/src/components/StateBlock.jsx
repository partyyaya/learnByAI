import { IconAlert, IconInbox, IconRefresh } from "./icons";

/** 轉圈圈。純 CSS 動畫，尺寸跟著字體大小 */
export function Spinner({ label }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="spinner__label">{label}</span> : null}
    </span>
  );
}

/**
 * 骨架列。第一次載入時用它撐住表格高度，畫面不會先塌掉再彈開。
 * 這比只放一個轉圈圈好：使用者能預期資料長什麼樣子。
 */
export function SkeletonRows({ rows = 6, columns = 4 }) {
  return Array.from({ length: rows }, (_, rowIndex) => (
    <tr key={rowIndex} className="skeleton-row">
      {Array.from({ length: columns }, (_, columnIndex) => (
        <td key={columnIndex}>
          <span className="skeleton" style={{ width: `${45 + ((rowIndex * 7 + columnIndex * 13) % 45)}%` }} />
        </td>
      ))}
    </tr>
  ));
}

/**
 * 失敗畫面。三件事一定要有：說發生什麼事、能不能重試、以及「重試」按鈕。
 * 網路類的錯誤（status 0）跟伺服器錯誤要分開講，使用者才知道是不是自己的問題。
 */
export function ErrorState({ error, onRetry }) {
  const isNetwork = error?.isNetworkError;

  return (
    <div className="state-block state-block--error">
      <span className="state-block__icon">
        <IconAlert size={26} />
      </span>
      <p className="state-block__title">{isNetwork ? "連不到伺服器" : "載入失敗"}</p>
      {/* 標題已經說了「連不到伺服器」，這裡再印一次 error.message（也是同一句話）
          等於什麼都沒講。斷線時改成給下一步該做什麼。 */}
      <p className="state-block__text">
        {isNetwork ? (
          "請確認連線狀態。如果是在「系統設定 → 模擬後端參數」打開了「模擬斷線」，把它關掉就會恢復。"
        ) : (
          <>
            {error?.message ?? "發生未知的錯誤"}
            {error?.status ? <span className="state-block__code">HTTP {error.status}</span> : null}
          </>
        )}
      </p>
      {onRetry ? (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          <IconRefresh size={16} />
          重新載入
        </button>
      ) : null}
    </div>
  );
}

/** 查無資料。跟「載入失敗」要長得不一樣，不然使用者會以為系統壞了 */
export function EmptyState({ title = "沒有資料", text }) {
  return (
    <div className="state-block">
      <span className="state-block__icon">
        <IconInbox size={26} />
      </span>
      <p className="state-block__title">{title}</p>
      {text ? <p className="state-block__text">{text}</p> : null}
    </div>
  );
}
