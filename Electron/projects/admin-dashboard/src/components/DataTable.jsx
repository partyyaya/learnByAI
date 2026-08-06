import { EmptyState, ErrorState, SkeletonRows } from "./StateBlock";

/**
 * 表格。把「四種狀態」一次處理掉，頁面就只要專心描述欄位：
 *
 *   第一次載入   → 骨架列
 *   重新載入     → 保留舊資料 + 半透明遮罩（不會閃成空白）
 *   失敗         → 錯誤畫面 + 重試
 *   成功但沒資料 → 查無資料
 *
 * columns 的形狀：
 *   { key, header, align?, width?, render?(row) }
 * 沒給 render 就直接印 row[key]。
 */
export function DataTable({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  emptyTitle,
  emptyText
}) {
  const hasRows = Array.isArray(rows) && rows.length > 0;

  // 錯誤與「載入完成但沒資料」都不畫表格本體，只留表頭反而更亂
  if (error && !hasRows) return <ErrorState error={error} onRetry={onRetry} />;
  if (!loading && !hasRows) return <EmptyState title={emptyTitle} text={emptyText} />;

  return (
    <div className={`table-wrap${loading && hasRows ? " is-refreshing" : ""}`}>
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{ width: column.width, textAlign: column.align ?? "left" }}
                scope="col"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hasRows
            ? rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((column) => (
                    <td key={column.key} style={{ textAlign: column.align ?? "left" }}>
                      {column.render ? column.render(row) : row[column.key]}
                    </td>
                  ))}
                </tr>
              ))
            : <SkeletonRows rows={8} columns={columns.length} />}
        </tbody>
      </table>
    </div>
  );
}
