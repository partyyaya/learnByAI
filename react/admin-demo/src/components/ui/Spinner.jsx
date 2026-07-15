// 載入指示器。用於 Query 的 isLoading / isFetching 狀態。
function Spinner({ label = '載入中…' }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner__ring" aria-hidden="true" />
      <span className="spinner__label">{label}</span>
    </div>
  )
}

export default Spinner
