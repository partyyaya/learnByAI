import { useLocation, useNavigate } from 'react-router-dom'
import Icon from '@/components/ui/Icon'
import { findMenuLabel } from '@/router/menu'
import { useAuthStore } from '@/stores/auth.store'
import { useUiStore } from '@/stores/ui.store'
import { initials } from '@/utils/format'

// 頂列：側欄開合鈕、目前頁面標題、主題切換、使用者資訊與登出。
// 只用 selector 取需要的欄位，避免無關狀態變更造成整條 header 重渲染（第 11 章）。
function Header() {
  const location = useLocation()
  const navigate = useNavigate()

  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)

  const theme = useUiStore((state) => state.theme)
  const toggleTheme = useUiStore((state) => state.toggleTheme)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)

  const title = findMenuLabel(location.pathname) || '後台管理'

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="topbar">
      <div className="topbar__left">
        <button
          className="icon-btn"
          onClick={toggleSidebar}
          aria-label="切換側欄"
        >
          <Icon name="feed" />
        </button>
        <h2 className="topbar__title">{title}</h2>
      </div>

      <div className="topbar__right">
        <button
          className="icon-btn"
          onClick={toggleTheme}
          aria-label="切換主題"
          title={theme === 'light' ? '切換到深色' : '切換到淺色'}
        >
          <Icon name={theme === 'light' ? 'moon' : 'sun'} />
        </button>

        <div className="topbar__user">
          <span className="avatar">{initials(user?.name)}</span>
          <div className="topbar__user-meta">
            <span className="topbar__user-name">{user?.name}</span>
            <span className="topbar__user-role">{user?.role}</span>
          </div>
        </div>

        <button className="icon-btn" onClick={handleLogout} aria-label="登出">
          <Icon name="logout" />
        </button>
      </div>
    </header>
  )
}

export default Header
