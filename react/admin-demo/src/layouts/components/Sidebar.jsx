import { NavLink } from 'react-router-dom'
import Icon from '@/components/ui/Icon'
import { getVisibleSections } from '@/router/menu'
import { useAuthStore } from '@/stores/auth.store'
import { useUiStore } from '@/stores/ui.store'

// 側欄：依登入者角色顯示可見選單（第 08 章路由 + 第 11 章 UI 狀態）。
// sidebarOpen 由 ui.store 控制，收合時只留圖示。
function Sidebar() {
  const role = useAuthStore((state) => state.user?.role)
  const open = useUiStore((state) => state.sidebarOpen)
  const sections = getVisibleSections(role)

  return (
    <aside className={`sidebar ${open ? '' : 'sidebar--collapsed'}`}>
      <div className="sidebar__brand">
        <span className="sidebar__logo">R</span>
        {open && <span className="sidebar__brand-text">React Admin</span>}
      </div>

      <nav className="sidebar__nav">
        {sections.map((section) => (
          <div className="sidebar__section" key={section.title}>
            {open && <p className="sidebar__section-title">{section.title}</p>}
            {section.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/courses'}
                className={({ isActive }) =>
                  `sidebar__link ${isActive ? 'is-active' : ''}`
                }
                title={item.label}
              >
                <Icon name={item.icon} />
                {open && <span>{item.label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  )
}

export default Sidebar
