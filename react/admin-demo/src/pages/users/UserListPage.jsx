import { useState } from 'react'
import { useUsersQuery } from '@/hooks/useUsersQuery'
import { formatDate, initials } from '@/utils/format'

import PageHeader from '@/components/ui/PageHeader'
import Card from '@/components/ui/Card'
import Badge from '@/components/ui/Badge'
import Icon from '@/components/ui/Icon'
import DataTable from '@/components/ui/DataTable'
import Pagination from '@/components/ui/Pagination'
import { ErrorState } from '@/components/ui/StateBlock'

const PAGE_SIZE = 8

const ROLE_LABELS = { admin: '管理員', editor: '編輯', viewer: '檢視者' }

// 使用者管理（僅 admin 可見，示範第 08 章角色守衛）。
// 這頁的篩選條件只在本頁使用、不跨元件共享，所以用 useState 就好——
// 不是所有狀態都得進 Zustand，這也是課程想傳達的判斷力。
function UserListPage() {
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('all')
  const [page, setPage] = useState(1)

  const filters = { search, role, page, pageSize: PAGE_SIZE }
  const { data, isError, error, refetch, isFetching } = useUsersQuery(filters)

  const rows = data?.items ?? []
  const total = data?.total ?? 0

  const columns = [
    {
      key: 'name',
      title: '使用者',
      render: (u) => (
        <div className="cell-user">
          <span className="avatar avatar--sm">{initials(u.name)}</span>
          <div>
            <div className="cell-user__name">{u.name}</div>
            <div className="cell-sub">@{u.username}</div>
          </div>
        </div>
      ),
    },
    { key: 'email', title: 'Email' },
    {
      key: 'role',
      title: '角色',
      width: 100,
      render: (u) => (
        <Badge tone={u.role === 'admin' ? 'purple' : u.role === 'editor' ? 'blue' : 'gray'}>
          {ROLE_LABELS[u.role] || u.role}
        </Badge>
      ),
    },
    {
      key: 'status',
      title: '狀態',
      width: 90,
      render: (u) => (
        <Badge tone={u.status === 'active' ? 'green' : 'gray'}>
          {u.status === 'active' ? '啟用' : '停用'}
        </Badge>
      ),
    },
    {
      key: 'createdAt',
      title: '建立時間',
      width: 120,
      render: (u) => formatDate(u.createdAt),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="使用者管理"
        chapter="第 08 · 11 章 · 角色守衛"
        subtitle="此頁僅限 admin 角色進入（editor 登入時看不到此選單、直接輸入網址會被導向 403）。"
      />

      <Card>
        <div className="toolbar">
          <div className="search-box">
            <Icon name="search" size={16} />
            <input
              value={search}
              aria-label="搜尋使用者"
              placeholder="搜尋姓名 / 帳號 / Email"
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
            />
          </div>

          <select
            className="input"
            aria-label="角色篩選"
            value={role}
            onChange={(e) => {
              setRole(e.target.value)
              setPage(1)
            }}
          >
            <option value="all">全部角色</option>
            <option value="admin">管理員</option>
            <option value="editor">編輯</option>
            <option value="viewer">檢視者</option>
          </select>

          {isFetching && <span className="toolbar__fetching">更新中…</span>}
        </div>

        {isError ? (
          <ErrorState message={error.message} onRetry={() => refetch()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(u) => u.id}
              loading={!data}
              emptyHint="找不到符合條件的使用者。"
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
    </div>
  )
}

export default UserListPage
