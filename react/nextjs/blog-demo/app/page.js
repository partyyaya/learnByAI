import Link from "next/link";
import { prisma } from "@/lib/prisma";

// 首頁列表用 ISR：60 秒內吃快取；後台異動時會 revalidatePath("/") 主動更新（第 12 章）
export const revalidate = 60;

export default async function HomePage() {
  // 讀資料 = Server Component 直接查 DB（不經 API）
  const posts = await prisma.post.findMany({
    where: { published: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="wrap">
      <h1>最新文章</h1>
      <p className="muted">共 {posts.length} 篇已發佈文章</p>

      {posts.length === 0 ? (
        <p className="empty">還沒有文章。到 <Link href="/admin">後台</Link> 發表第一篇吧。</p>
      ) : (
        <ul className="post-list">
          {posts.map((post) => (
            <li key={post.id} className="post-item">
              <Link href={`/posts/${post.id}`} className="post-title">
                {post.title}
              </Link>
              <p className="post-excerpt">{post.content.slice(0, 60)}…</p>
              <time className="post-date">
                {new Date(post.createdAt).toLocaleDateString("zh-TW")}
              </time>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
