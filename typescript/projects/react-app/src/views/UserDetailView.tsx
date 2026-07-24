import { useCallback, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getUserPosts } from '@/api/users'
import { useAsync } from '@/hooks/useAsync'
import { useFavoritesStore } from '@/stores/useFavoritesStore'
import { useUserStore } from '@/stores/useUserStore'
import type { Post } from '@/types'

export default function UserDetailView() {
  // useParams 的值型別是 string | undefined，需自行轉成 number
  const { id } = useParams<{ id: string }>()
  const userId = Number(id)

  // 從 store 取單一使用者
  const current = useUserStore((state) => state.current)
  const loading = useUserStore((state) => state.loading)
  const error = useUserStore((state) => state.error)
  const fetchUser = useUserStore((state) => state.fetchUser)

  // 收藏狀態
  const isFavorite = useFavoritesStore((state) => state.isFavorite(userId))
  const toggle = useFavoritesStore((state) => state.toggle)

  // 用泛型 hook 載入該使用者的文章；用 useCallback 讓 fn 隨 userId 穩定
  const fetchPosts = useCallback(() => getUserPosts(userId), [userId])
  const {
    data: posts,
    loading: postsLoading,
    error: postsError,
    run: runPosts,
  } = useAsync<Post[]>(fetchPosts)

  // userId 改變時，重新載入使用者與其文章
  useEffect(() => {
    if (Number.isNaN(userId)) return
    void fetchUser(userId)
    void runPosts()
  }, [userId, fetchUser, runPosts])

  if (Number.isNaN(userId)) {
    return <p className="status status-error">無效的使用者代碼</p>
  }

  return (
    <section className="user-detail">
      <Link className="back-link" to="/users">
        ← 回列表
      </Link>

      {loading && <p className="status">載入中…</p>}
      {error && <p className="status status-error">發生錯誤：{error}</p>}

      {!loading && current && current.id === userId && (
        <>
          <header className="user-detail-header">
            <h1>{current.name}</h1>
            <button
              type="button"
              className="favorite-button"
              onClick={() => toggle(userId)}
              aria-pressed={isFavorite}
            >
              {isFavorite ? '★ 取消收藏' : '☆ 加入收藏'}
            </button>
          </header>

          <ul className="user-detail-meta">
            <li>帳號：{current.username}</li>
            <li>Email：{current.email}</li>
            <li>電話：{current.phone}</li>
            <li>網站：{current.website}</li>
            <li>公司：{current.company.name}</li>
            <li>
              地址：{current.address.city} {current.address.street}
            </li>
          </ul>

          <h2>文章</h2>
          {postsLoading && <p className="status">文章載入中…</p>}
          {postsError && (
            <p className="status status-error">文章載入失敗：{postsError}</p>
          )}
          {!postsLoading && !postsError && (
            <ul className="post-list">
              {posts?.map((post) => (
                <li key={post.id} className="post-item">
                  <h3>{post.title}</h3>
                  <p>{post.body}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
