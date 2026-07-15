import { formatNumber } from '@/utils/format'

// 儀表板數字卡。delta 為與上期相比的百分比（正綠負紅）。
function StatCard({ label, value, delta, suffix = '' }) {
  const isUp = Number(delta) >= 0
  return (
    <div className="stat-card">
      <p className="stat-card__label">{label}</p>
      <p className="stat-card__value">
        {typeof value === 'number' ? formatNumber(value) : value}
        {suffix}
      </p>
      {delta != null && (
        <p className={`stat-card__delta ${isUp ? 'is-up' : 'is-down'}`}>
          {isUp ? '▲' : '▼'} {Math.abs(delta)}%
          <span className="stat-card__delta-note">較上週</span>
        </p>
      )}
    </div>
  )
}

export default StatCard
