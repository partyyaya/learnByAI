import Button from './Button'

// 空狀態 / 錯誤狀態的共用區塊。
// EmptyState：查無資料時使用。
// ErrorState：Query isError 時使用，附「重試」按鈕。

export function EmptyState({ title = '目前沒有資料', hint }) {
  return (
    <div className="state-block">
      <div className="state-block__emoji">📭</div>
      <p className="state-block__title">{title}</p>
      {hint && <p className="state-block__hint">{hint}</p>}
    </div>
  )
}

export function ErrorState({ message = '載入失敗', onRetry }) {
  return (
    <div className="state-block">
      <div className="state-block__emoji">⚠️</div>
      <p className="state-block__title">{message}</p>
      {onRetry && (
        <Button variant="subtle" size="sm" onClick={onRetry}>
          重試
        </Button>
      )}
    </div>
  )
}
