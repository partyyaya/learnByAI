import { memo, useCallback, useMemo, useState } from 'react'
import PageHeader from '@/components/ui/PageHeader'
import Card from '@/components/ui/Card'
import Badge from '@/components/ui/Badge'

// 效能實驗室（第 13 章）：memo / useMemo / useCallback 的實際效果。
// 用一份 2000 筆的大清單 + 昂貴計算，示範如何避免無關狀態變更造成的重算與重渲染。

const ALL_ROWS = Array.from({ length: 2000 }, (_, i) => ({
  id: i + 1,
  title: `課程項目 #${i + 1}`,
  level: i % 3 === 0 ? 'advanced' : i % 2 === 0 ? 'intermediate' : 'beginner',
  minutes: 15 + (i % 50),
}))

// 模擬昂貴計算，方便觀察 useMemo 是否有重算。
function expensiveFilter(list, keyword, level) {
  const text = keyword.trim().toLowerCase()
  let cost = 0
  for (let i = 0; i < 300000; i += 1) cost += i
  if (cost < 0) console.log('never') // 防止被最佳化移除

  return list.filter((row) => {
    const matchText = !text || row.title.includes(text)
    const matchLevel = level === 'all' || row.level === level
    return matchText && matchLevel
  })
}

// 用 React.memo 包起來：父層的無關狀態（例如切換強調色）變更時，
// 只要 props 沒變，這個清單就不會重渲染。
const RowList = memo(function RowList({ rows, onPick, pickedId }) {
  return (
    <ul className="perf-list">
      {rows.slice(0, 100).map((row) => (
        <li
          key={row.id}
          className={pickedId === row.id ? 'is-picked' : ''}
          onClick={() => onPick(row.id)}
        >
          <span>{row.title}</span>
          <Badge tone="gray">{row.level}</Badge>
        </li>
      ))}
    </ul>
  )
})

function PerformanceLabPage() {
  const [keyword, setKeyword] = useState('')
  const [level, setLevel] = useState('all')
  const [accent, setAccent] = useState(false) // 與清單無關的狀態
  const [pickedId, setPickedId] = useState(null)

  // useMemo：只有 keyword / level 改變才重算昂貴的篩選；切換 accent 不會觸發。
  const filtered = useMemo(
    () => expensiveFilter(ALL_ROWS, keyword, level),
    [keyword, level]
  )

  // useCallback：固定函式引用，讓 memo 化的 RowList 不會因為新函式而失效重渲染。
  const handlePick = useCallback((id) => setPickedId(id), [])

  return (
    <div className={`page ${accent ? 'accent-on' : ''}`}>
      <PageHeader
        title="效能實驗室"
        chapter="第 13 章 · memo / useMemo / useCallback"
        subtitle="2000 筆資料 + 昂貴計算：觀察無關狀態變更時是否還會重算 / 重渲染。"
      />

      <Card>
        <div className="toolbar">
          <input
            className="input"
            value={keyword}
            placeholder="搜尋（會觸發昂貴計算）"
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select
            className="input"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            <option value="all">全部</option>
            <option value="beginner">beginner</option>
            <option value="intermediate">intermediate</option>
            <option value="advanced">advanced</option>
          </select>
          <button
            className="chip"
            onClick={() => setAccent((v) => !v)}
            title="這是與清單無關的狀態；有了 memo/useMemo/useCallback，切它不會重算清單"
          >
            切換強調色（無關狀態）
          </button>
        </div>

        <p className="muted">
          篩選結果 {filtered.length} 筆（僅渲染前 100 筆以控制 DOM 數量）。
          打開 React DevTools Profiler，比較切換「搜尋」與「強調色」時的重渲染差異。
        </p>

        <RowList rows={filtered} onPick={handlePick} pickedId={pickedId} />
      </Card>
    </div>
  )
}

export default PerformanceLabPage
