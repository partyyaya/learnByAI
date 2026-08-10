import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useCoursesQuery } from '@/hooks/useCoursesQuery'
import { useCourseMutations } from '@/hooks/useCourseMutations'
import { useCourseFilterStore } from '@/stores/courseFilter.store'
import { useUiStore } from '@/stores/ui.store'
import { LEVEL_LABELS, LEVEL_TONES, formatDate } from '@/utils/format'

import PageHeader from '@/components/ui/PageHeader'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Badge from '@/components/ui/Badge'
import Icon from '@/components/ui/Icon'
import DataTable from '@/components/ui/DataTable'
import Pagination from '@/components/ui/Pagination'
import { ErrorState } from '@/components/ui/StateBlock'
import CourseFormModal from './CourseFormModal'

const PAGE_SIZE = 8

// 課程管理（第 12 章整合示範）：
// - 篩選 / 分頁條件放 Zustand（本地 UI 狀態）
// - 條件組進 queryKey → TanStack Query 自動抓對應資料（伺服器狀態）
// - 新增 / 上下架 / 刪除用 useMutation + 樂觀更新（第 10 章）
function CourseListPage() {
  // 1) 從 Zustand 取篩選條件（各自 selector，最小訂閱）
  const search = useCourseFilterStore((s) => s.search)
  const level = useCourseFilterStore((s) => s.level)
  const sort = useCourseFilterStore((s) => s.sort)
  const page = useCourseFilterStore((s) => s.page)
  const setSearch = useCourseFilterStore((s) => s.setSearch)
  const setLevel = useCourseFilterStore((s) => s.setLevel)
  const setSort = useCourseFilterStore((s) => s.setSort)
  const setPage = useCourseFilterStore((s) => s.setPage)
  const resetFilters = useCourseFilterStore((s) => s.resetFilters)

  // 收藏（第 11 章 persist）
  const bookmarkedIds = useUiStore((s) => s.bookmarkedCourseIds)
  const toggleBookmark = useUiStore((s) => s.toggleBookmark)

  // 2) 條件組成 filters，進 queryKey
  const filters = { search, level, sort, page, pageSize: PAGE_SIZE }
  const { data, isError, error, refetch, isFetching } = useCoursesQuery(filters)

  // 3) mutation 綁定「目前這一頁」的快取，才能精準做樂觀更新
  const { createCourse, updateCourse, deleteCourse } =
    useCourseMutations(filters)

  const [modalOpen, setModalOpen] = useState(false)

  const rows = data?.items ?? []
  const total = data?.total ?? 0

  function handleCreate(payload) {
    createCourse.mutate(payload, {
      onSuccess: () => setModalOpen(false),
    })
  }

  function handleTogglePublish(course) {
    updateCourse.mutate({ id: course.id, patch: { published: !course.published } })
  }

  function handleDelete(course) {
    if (window.confirm(`確定要刪除「${course.title}」嗎？`)) {
      deleteCourse.mutate(course.id)
    }
  }

  const columns = [
    {
      key: 'title',
      title: '課程名稱',
      render: (c) => (
        <div className="cell-title">
          <Link to={`/courses/${c.id}`} className="link">
            {c.title}
          </Link>
          {c._optimistic && <span className="tag-optimistic">暫存中</span>}
          <span className="cell-sub">
            {c.category} · {c.minutes} 分鐘
          </span>
        </div>
      ),
    },
    {
      key: 'level',
      title: '難度',
      width: 90,
      render: (c) => (
        <Badge tone={LEVEL_TONES[c.level]}>{LEVEL_LABELS[c.level]}</Badge>
      ),
    },
    {
      key: 'students',
      title: '報名',
      width: 90,
      align: 'right',
      render: (c) => c.students.toLocaleString('en-US'),
    },
    {
      key: 'rating',
      title: '評分',
      width: 80,
      align: 'right',
      render: (c) => `★ ${c.rating}`,
    },
    {
      key: 'published',
      title: '狀態',
      width: 110,
      render: (c) => (
        <button
          className="pill-toggle"
          onClick={() => handleTogglePublish(c)}
          disabled={c._optimistic}
        >
          <Badge tone={c.published ? 'green' : 'gray'}>
            {c.published ? '已上架' : '未上架'}
          </Badge>
        </button>
      ),
    },
    {
      key: 'updatedAt',
      title: '更新時間',
      width: 120,
      render: (c) => formatDate(c.updatedAt),
    },
    {
      key: 'actions',
      title: '操作',
      width: 120,
      render: (c) => (
        <div className="row-actions">
          <button
            className={`icon-btn ${bookmarkedIds.includes(c.id) ? 'is-bookmarked' : ''}`}
            onClick={() => toggleBookmark(c.id)}
            title="收藏"
          >
            <Icon name="star" size={16} />
          </button>
          <button
            className="icon-btn icon-btn--danger"
            onClick={() => handleDelete(c)}
            disabled={c._optimistic}
            title="刪除"
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="課程管理"
        chapter="第 10 · 12 章 · Zustand + Query"
        subtitle="篩選條件存 Zustand，變動即透過 queryKey 自動重抓；新增/上下架/刪除皆為樂觀更新。"
        actions={
          <Button onClick={() => setModalOpen(true)}>
            <Icon name="plus" size={16} /> 新增課程
          </Button>
        }
      />

      <Card>
        <div className="toolbar">
          {/* 工具列的控制項沒有可見的文字標籤（版面考量），
              因此用 aria-label 補上可及名稱：讀螢幕的使用者才知道這格是做什麼的，
              測試也才能用 getByLabelText 這種使用者視角的方式定位。
              placeholder 不能取代 label——它一開始打字就消失了。 */}
          <div className="search-box">
            <Icon name="search" size={16} />
            <input
              value={search}
              aria-label="搜尋課程名稱"
              placeholder="搜尋課程名稱"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            className="input"
            aria-label="難度篩選"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            <option value="all">全部難度</option>
            <option value="beginner">入門</option>
            <option value="intermediate">中階</option>
            <option value="advanced">進階</option>
          </select>

          <select
            className="input"
            aria-label="排序方式"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="updated-desc">最近更新</option>
            <option value="students-desc">報名人數多</option>
            <option value="rating-desc">評分高</option>
            <option value="title-asc">名稱 A→Z</option>
          </select>

          <Button variant="subtle" onClick={resetFilters}>
            重設
          </Button>

          {isFetching && <span className="toolbar__fetching">更新中…</span>}
        </div>

        {isError ? (
          <ErrorState message={error.message} onRetry={() => refetch()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(c) => c.id}
              loading={!data}
              emptyHint="換個關鍵字或重設篩選條件試試。"
            />
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onChange={setPage}
            />
          </>
        )}
      </Card>

      <CourseFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={handleCreate}
        pending={createCourse.isPending}
        errorMessage={createCourse.isError ? createCourse.error.message : ''}
      />
    </div>
  )
}

export default CourseListPage
