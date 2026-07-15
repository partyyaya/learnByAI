import { useDashboardQuery } from '@/hooks/useDashboardQuery'
import PageHeader from '@/components/ui/PageHeader'
import StatCard from '@/components/ui/StatCard'
import Card from '@/components/ui/Card'
import Spinner from '@/components/ui/Spinner'
import Button from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/StateBlock'

// 儀表板（第 09 章）：用 useQuery 取代手寫 loading/error 樣板碼。
function DashboardPage() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useDashboardQuery()

  if (isLoading) return <Spinner label="載入儀表板…" />
  if (isError)
    return <ErrorState message={error.message} onRetry={() => refetch()} />

  const { stats, categoryStats, trend } = data
  const maxCategory = Math.max(...categoryStats.map((c) => c.value), 1)
  const maxTrend = Math.max(...trend.map((t) => t.value), 1)

  return (
    <div className="page">
      <PageHeader
        title="儀表板"
        chapter="第 09 章 · useQuery"
        subtitle="所有數字由 TanStack Query 取得，並在課程新增/刪除後自動更新。"
        actions={
          <Button
            variant="subtle"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? '更新中…' : '重新整理'}
          </Button>
        }
      />

      <div className="stat-grid">
        {stats.map((s) => (
          <StatCard
            key={s.key}
            label={s.label}
            value={s.value}
            delta={s.delta}
          />
        ))}
      </div>

      <div className="dashboard-grid">
        <Card title="各分類課程數">
          <div className="bar-chart">
            {categoryStats.map((c) => (
              <div className="bar-chart__row" key={c.name}>
                <span className="bar-chart__label">{c.name}</span>
                <div className="bar-chart__track">
                  <div
                    className="bar-chart__fill"
                    style={{ width: `${(c.value / maxCategory) * 100}%` }}
                  />
                </div>
                <span className="bar-chart__value">{c.value}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="近 7 日新報名">
          <div className="spark">
            {trend.map((t) => (
              <div className="spark__col" key={t.day}>
                <div
                  className="spark__bar"
                  style={{ height: `${(t.value / maxTrend) * 100}%` }}
                  title={`${t.value} 人`}
                />
                <span className="spark__label">{t.day}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}

export default DashboardPage
