import { useEffect, useMemo, useState } from 'react'
import UserCard from '@/components/UserCard'
import { useUserStore } from '@/stores/useUserStore'

// 使用者列表頁：載入資料、顯示 loading / error / 列表，並提供前端搜尋
export default function UsersView() {
  const users = useUserStore((state) => state.users)
  const loading = useUserStore((state) => state.loading)
  const error = useUserStore((state) => state.error)
  const fetchUsers = useUserStore((state) => state.fetchUsers)

  // 受控輸入：搜尋關鍵字
  const [keyword, setKeyword] = useState('')

  // 掛載時載入使用者（fetchUsers 為穩定的 action 參考）
  useEffect(() => {
    void fetchUsers()
  }, [fetchUsers])

  // 依 name / username 做前端過濾；用 useMemo 避免每次 render 重算
  const filteredUsers = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return users
    return users.filter(
      (user) =>
        user.name.toLowerCase().includes(kw) ||
        user.username.toLowerCase().includes(kw),
    )
  }, [users, keyword])

  return (
    <section className="users">
      <h1>使用者列表</h1>

      <input
        className="search-input"
        type="search"
        placeholder="以姓名或帳號搜尋…"
        aria-label="搜尋使用者"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
      />

      {loading && <p className="status">載入中…</p>}
      {error && <p className="status status-error">發生錯誤：{error}</p>}

      {!loading && !error && (
        <>
          <p className="hint">
            共 {users.length} 位使用者，顯示 {filteredUsers.length} 位
          </p>
          {filteredUsers.length === 0 ? (
            <p className="status">查無符合的使用者</p>
          ) : (
            <div className="user-grid">
              {filteredUsers.map((user) => (
                <UserCard key={user.id} user={user} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
