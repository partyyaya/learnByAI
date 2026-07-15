import { Link } from 'react-router-dom'
import Button from '@/components/ui/Button'

// 403：ProtectedRoute 角色守衛不通過時導向此頁。
function ForbiddenPage() {
  return (
    <div className="fallback-page">
      <p className="fallback-page__code">403</p>
      <h1 className="fallback-page__title">沒有存取權限</h1>
      <p className="muted">你目前的角色無法進入這個頁面。</p>
      <Link to="/dashboard">
        <Button>回到儀表板</Button>
      </Link>
    </div>
  )
}

export default ForbiddenPage
