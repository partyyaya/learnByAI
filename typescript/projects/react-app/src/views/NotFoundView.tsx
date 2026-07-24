import { Link } from 'react-router-dom'

export default function NotFoundView() {
  return (
    <section className="not-found">
      <h1>404</h1>
      <p>找不到這個頁面。</p>
      <Link to="/">回首頁</Link>
    </section>
  )
}
