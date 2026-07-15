import { useUiStore } from '@/stores/ui.store'
import { useAuthStore } from '@/stores/auth.store'
import PageHeader from '@/components/ui/PageHeader'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Badge from '@/components/ui/Badge'

// 設定頁（第 11 章）：示範 Zustand + persist。
// 這裡改的偏好（主題、側欄、收藏）都會寫進 localStorage，重整後保留。
function SettingsPage() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const bookmarkedIds = useUiStore((s) => s.bookmarkedCourseIds)
  const toggleBookmark = useUiStore((s) => s.toggleBookmark)
  const clearBookmarks = useUiStore((s) => s.clearBookmarks)

  const user = useAuthStore((s) => s.user)

  return (
    <div className="page">
      <PageHeader
        title="設定"
        chapter="第 11 章 · Zustand persist"
        subtitle="偏好設定存於 localStorage（key：admin-ui / admin-auth），重整不流失。"
      />

      <div className="settings-grid">
        <Card title="外觀">
          <div className="setting-row">
            <div>
              <p className="setting-row__title">主題</p>
              <p className="muted">切換亮色 / 暗色（也可用右上角快捷鈕）。</p>
            </div>
            <div className="segmented">
              <button
                className={theme === 'light' ? 'is-active' : ''}
                onClick={() => setTheme('light')}
              >
                淺色
              </button>
              <button
                className={theme === 'dark' ? 'is-active' : ''}
                onClick={() => setTheme('dark')}
              >
                深色
              </button>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <p className="setting-row__title">側欄</p>
              <p className="muted">預設展開或收合。</p>
            </div>
            <Button variant="subtle" size="sm" onClick={toggleSidebar}>
              {sidebarOpen ? '目前：展開' : '目前：收合'}
            </Button>
          </div>
        </Card>

        <Card title="帳號">
          <dl className="detail-list">
            <div>
              <dt>姓名</dt>
              <dd>{user?.name}</dd>
            </div>
            <div>
              <dt>帳號</dt>
              <dd>@{user?.username}</dd>
            </div>
            <div>
              <dt>角色</dt>
              <dd>
                <Badge tone={user?.role === 'admin' ? 'purple' : 'blue'}>
                  {user?.role}
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>

        <Card
          title={`我的收藏（${bookmarkedIds.length}）`}
          actions={
            bookmarkedIds.length > 0 && (
              <Button variant="subtle" size="sm" onClick={clearBookmarks}>
                清除全部
              </Button>
            )
          }
        >
          {bookmarkedIds.length === 0 ? (
            <p className="muted">
              還沒有收藏。到「課程管理」或課程詳情頁點星號即可收藏。
            </p>
          ) : (
            <div className="chip-wrap">
              {bookmarkedIds.map((id) => (
                <button
                  key={id}
                  className="chip chip--removable"
                  onClick={() => toggleBookmark(id)}
                  title="點擊移除"
                >
                  課程 #{id} ✕
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

export default SettingsPage
