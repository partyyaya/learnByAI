import { useNavigate, useParams } from 'react-router-dom'
import { useCourseDetailQuery } from '@/hooks/useCoursesQuery'
import { useUiStore } from '@/stores/ui.store'
import { LEVEL_LABELS, LEVEL_TONES, formatDate, formatNumber } from '@/utils/format'

import PageHeader from '@/components/ui/PageHeader'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Badge from '@/components/ui/Badge'
import Icon from '@/components/ui/Icon'
import Spinner from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/StateBlock'

// 課程詳情（第 08 章）：用 useParams 取動態路由參數 :courseId，
// 再交給 useCourseDetailQuery 依 id 抓單筆資料。
function CourseDetailPage() {
  const { courseId } = useParams()
  const navigate = useNavigate()

  const { data: course, isLoading, isError, error, refetch } =
    useCourseDetailQuery(courseId)

  const bookmarkedIds = useUiStore((s) => s.bookmarkedCourseIds)
  const toggleBookmark = useUiStore((s) => s.toggleBookmark)

  if (isLoading) return <Spinner label="載入課程詳情…" />
  if (isError)
    return <ErrorState message={error.message} onRetry={() => refetch()} />

  const isBookmarked = bookmarkedIds.includes(course.id)

  return (
    <div className="page">
      <PageHeader
        title={course.title}
        chapter="第 08 章 · useParams"
        subtitle={`課程編號 #${course.id}`}
        actions={
          <Button variant="subtle" onClick={() => navigate(-1)}>
            <Icon name="back" size={16} /> 返回
          </Button>
        }
      />

      <div className="detail-grid">
        <Card title="課程資訊">
          <p className="detail-desc">{course.description}</p>
          <dl className="detail-list">
            <div>
              <dt>難度</dt>
              <dd>
                <Badge tone={LEVEL_TONES[course.level]}>
                  {LEVEL_LABELS[course.level]}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>分類</dt>
              <dd>{course.category}</dd>
            </div>
            <div>
              <dt>時長</dt>
              <dd>{course.minutes} 分鐘</dd>
            </div>
            <div>
              <dt>狀態</dt>
              <dd>
                <Badge tone={course.published ? 'green' : 'gray'}>
                  {course.published ? '已上架' : '未上架'}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>最後更新</dt>
              <dd>{formatDate(course.updatedAt)}</dd>
            </div>
          </dl>
        </Card>

        <div className="detail-side">
          <Card>
            <div className="metric">
              <span className="metric__value">
                {formatNumber(course.students)}
              </span>
              <span className="metric__label">累計報名人次</span>
            </div>
            <div className="metric">
              <span className="metric__value">★ {course.rating}</span>
              <span className="metric__label">平均評分</span>
            </div>
          </Card>

          <Button
            variant={isBookmarked ? 'primary' : 'subtle'}
            onClick={() => toggleBookmark(course.id)}
          >
            <Icon name="star" size={16} />
            {isBookmarked ? '已收藏' : '加入收藏'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default CourseDetailPage
