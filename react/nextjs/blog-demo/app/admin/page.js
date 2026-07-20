import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { deletePost, togglePublish } from "./actions";
import PostForm from "./PostForm";
import SubmitButton from "./SubmitButton";

export default async function AdminPage() {
  // 後台顯示「全部」文章（含草稿）；因為 layout 讀了 cookie，本頁為動態渲染
  const posts = await prisma.post.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <>
      <PostForm />

      <h2>所有文章（{posts.length}）</h2>
      <ul className="admin-table">
        {posts.map((post) => (
          <li key={post.id} className="admin-row">
            <div>
              <div className="title">{post.title}</div>
              <span className={`badge ${post.published ? "badge-on" : "badge-off"}`}>
                {post.published ? "已發佈" : "草稿"}
              </span>
            </div>
            <div className="actions">
              {post.published && (
                <Link className="btn btn-ghost" href={`/posts/${post.id}`}>
                  檢視
                </Link>
              )}
              {/* 切換發佈狀態 */}
              <form action={togglePublish}>
                <input type="hidden" name="id" value={post.id} />
                <SubmitButton className="btn btn-ghost">
                  {post.published ? "轉為草稿" : "發佈"}
                </SubmitButton>
              </form>
              {/* 刪除 */}
              <form action={deletePost}>
                <input type="hidden" name="id" value={post.id} />
                <SubmitButton className="btn btn-danger">刪除</SubmitButton>
              </form>
            </div>
          </li>
        ))}
        {posts.length === 0 && <li className="muted">還沒有文章。</li>}
      </ul>
    </>
  );
}
