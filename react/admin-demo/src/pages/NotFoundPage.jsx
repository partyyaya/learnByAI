import { Link } from 'react-router-dom'
import Button from '@/components/ui/Button'

// 404（第 08 章）：巢狀 * 萬用路由，讓未知網址有明確回饋。
function NotFoundPage() {
  return (
    <div className="fallback-page">
      <p className="fallback-page__code">404</p>
      <h1 className="fallback-page__title">找不到這個頁面</h1>
      <p className="muted">你造訪的網址不存在，或已被移動。</p>
      <Link to="/dashboard">
        <Button>回到儀表板</Button>
      </Link>
    </div>
  )
}

export default NotFoundPage
