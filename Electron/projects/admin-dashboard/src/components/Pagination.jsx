import { IconChevronLeft, IconChevronRight } from "./icons";
import { Select } from "./Select";
import { formatNumber } from "../utils/format";

const PAGE_SIZE_OPTIONS = [10, 20, 50].map((size) => ({ value: String(size), label: String(size) }));

/**
 * 頁碼永遠只顯示 7 個位置，中間用 … 省略。
 * 直接把 totalPages 全印出來的話，資料一多就會有一整排數字擠爆版面。
 */
function pageItems(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

  // 目前頁在頭尾附近時，省略號只出現在另一邊
  if (page <= 4) return [1, 2, 3, 4, 5, "…", totalPages];
  if (page >= totalPages - 3) {
    return [1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "…", page - 1, page, page + 1, "…", totalPages];
}

export function Pagination({ pagination, onChange, pageSize, onPageSizeChange }) {
  if (!pagination) return null;

  const { page, total, totalPages } = pagination;
  const from = total === 0 ? 0 : (page - 1) * pagination.pageSize + 1;
  const to = Math.min(total, page * pagination.pageSize);

  return (
    <div className="pagination">
      <p className="pagination__summary">
        顯示第 {formatNumber(from)}–{formatNumber(to)} 筆，共 {formatNumber(total)} 筆
      </p>

      <div className="pagination__controls">
        {onPageSizeChange ? (
          <div className="pagination__size">
            <span>每頁</span>
            <Select
              value={String(pageSize)}
              onChange={(next) => onPageSizeChange(Number(next))}
              options={PAGE_SIZE_OPTIONS}
              aria-label="每頁筆數"
            />
            <span>筆</span>
          </div>
        ) : null}

        <button
          type="button"
          className="pagination__btn"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          aria-label="上一頁"
        >
          <IconChevronLeft size={16} />
        </button>

        {pageItems(page, totalPages).map((item, index) =>
          item === "…" ? (
            // 省略號可能出現兩次，所以 key 要帶上位置
            <span key={`gap-${index}`} className="pagination__gap">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className={`pagination__btn${item === page ? " is-active" : ""}`}
              onClick={() => onChange(item)}
              aria-current={item === page ? "page" : undefined}
            >
              {item}
            </button>
          )
        )}

        <button
          type="button"
          className="pagination__btn"
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="下一頁"
        >
          <IconChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
