import { NavLink } from 'react-router-dom'
import { useFavoritesStore } from '@/stores/useFavoritesStore'

// 導覽列：提供首頁 / 使用者列表連結，並即時顯示收藏數量
export default function NavBar() {
  // 用 selector 只訂閱 ids 的長度，數量變動時才重繪
  const favoriteCount = useFavoritesStore((state) => state.ids.length)

  return (
    <nav className="navbar">
      <div className="navbar-brand">使用者與文章瀏覽器</div>
      <div className="navbar-links">
        <NavLink to="/" end>
          首頁
        </NavLink>
        <NavLink to="/users">使用者</NavLink>
        <span className="navbar-badge">★ 收藏 {favoriteCount}</span>
      </div>
    </nav>
  )
}
