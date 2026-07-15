import Button from './Button'

// 分頁列。依 total / pageSize 算出總頁數，提供上一頁 / 下一頁與頁碼資訊。
function Pagination({ page, pageSize, total, onChange }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const canPrev = page > 1
  const canNext = page < totalPages

  return (
    <div className="pagination">
      <span className="pagination__info">
        共 {total} 筆 · 第 {page} / {totalPages} 頁
      </span>
      <div className="pagination__controls">
        <Button
          variant="subtle"
          size="sm"
          disabled={!canPrev}
          onClick={() => onChange(page - 1)}
        >
          上一頁
        </Button>
        <Button
          variant="subtle"
          size="sm"
          disabled={!canNext}
          onClick={() => onChange(page + 1)}
        >
          下一頁
        </Button>
      </div>
    </div>
  )
}

export default Pagination
