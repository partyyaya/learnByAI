import { Link } from 'react-router-dom'
import { useCoursesInfiniteQuery } from '@/hooks/useCoursesQuery'
import { LEVEL_LABELS, LEVEL_TONES } from '@/utils/format'

import PageHeader from '@/components/ui/PageHeader'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/StateBlock'

// 課程動態（第 10 章）：useInfiniteQuery 的「載入更多」。
// 把多頁資料 flatMap 成單一陣列渲染，nextPage 由後端回傳決定是否還有下一頁。
function CourseFeedPage() {
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useCoursesInfiniteQuery()

  if (isLoading) return <Spinner label="載入課程動態…" />
  if (isError)
    return <ErrorState message={error.message} onRetry={() => refetch()} />

  const items = data.pages.flatMap((page) => page.items)

  return (
    <div className="page">
      <PageHeader
        title="課程動態"
        chapter="第 10 章 · useInfiniteQuery"
        subtitle="以「載入更多」分頁載入，適合資料量大的清單。"
      />

      <div className="feed-grid">
        {items.map((course) => (
          <Card key={course.id} className="feed-card">
            <div className="feed-card__head">
              <Badge tone={LEVEL_TONES[course.level]}>
                {LEVEL_LABELS[course.level]}
              </Badge>
              <span className="feed-card__cat">{course.category}</span>
            </div>
            <Link to={`/courses/${course.id}`} className="feed-card__title link">
              {course.title}
            </Link>
            <p className="feed-card__desc">{course.description}</p>
            <div className="feed-card__meta">
              <span>★ {course.rating}</span>
              <span>{course.minutes} 分鐘</span>
              <span>{course.students.toLocaleString('en-US')} 人報名</span>
            </div>
          </Card>
        ))}
      </div>

      <div className="feed-more">
        <Button
          variant="subtle"
          onClick={() => fetchNextPage()}
          disabled={!hasNextPage || isFetchingNextPage}
        >
          {isFetchingNextPage
            ? '載入中…'
            : hasNextPage
              ? '載入更多'
              : '已經到底了'}
        </Button>
      </div>
    </div>
  )
}

export default CourseFeedPage
