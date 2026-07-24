import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useFavoritesStore } from '@/stores/useFavoritesStore'
import type { User } from '@/types'

// 元件 props 型別
interface UserCardProps {
  user: User
}

export default function UserCard({ user }: UserCardProps) {
  const navigate = useNavigate()
  // 分別訂閱 isFavorite 與 toggle，避免不必要的重繪
  const isFavorite = useFavoritesStore((state) => state.isFavorite(user.id))
  const toggle = useFavoritesStore((state) => state.toggle)

  // 點卡片導向詳細頁
  function goToDetail() {
    navigate(`/users/${user.id}`)
  }

  // 點收藏按鈕時，阻止事件冒泡，避免同時觸發卡片導頁
  function handleToggle(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    toggle(user.id)
  }

  return (
    <article className="user-card" onClick={goToDetail}>
      <div className="user-card-body">
        <h3>{user.name}</h3>
        <p className="user-card-email">{user.email}</p>
        <p className="user-card-company">{user.company.name}</p>
      </div>
      <button
        type="button"
        className="favorite-button"
        onClick={handleToggle}
        aria-pressed={isFavorite}
      >
        {isFavorite ? '★ 取消' : '☆ 收藏'}
      </button>
    </article>
  )
}
