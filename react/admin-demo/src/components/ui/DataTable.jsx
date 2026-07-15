import Spinner from './Spinner'
import { EmptyState } from './StateBlock'

// 簡單但夠用的表格元件。
// columns: [{ key, title, render?(row), width?, align? }]
// rows: 資料陣列；rowKey: 取唯一 key 的函式。
// loading 時顯示 Spinner；無資料顯示 EmptyState。
function DataTable({ columns, rows, rowKey, loading, emptyHint }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{ width: col.width, textAlign: col.align || 'left' }}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((col) => (
                <td key={col.key} style={{ textAlign: col.align || 'left' }}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {loading && (
        <div className="table-overlay">
          <Spinner />
        </div>
      )}

      {!loading && rows.length === 0 && (
        <EmptyState hint={emptyHint} />
      )}
    </div>
  )
}

export default DataTable
