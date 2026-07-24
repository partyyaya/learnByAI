import { Link } from 'react-router-dom'

// 首頁：簡短介紹 + 前往使用者列表的連結
export default function HomeView() {
  return (
    <section className="home">
      <h1>使用者與文章瀏覽器</h1>
      <p>
        這是一個以 React 19 + TypeScript 打造的教學範例，資料來源為公開的
        JSONPlaceholder API。它示範了型別化的 axios API 層、Zustand
        狀態管理、React Router 路由，以及可重用的泛型 hook。
      </p>
      <Link className="button-link" to="/users">
        瀏覽使用者 →
      </Link>
    </section>
  )
}
