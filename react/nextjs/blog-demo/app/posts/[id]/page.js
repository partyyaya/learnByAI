import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

async function getPost(id) {
  const numId = Number(id);
  if (!Number.isInteger(numId)) return null;
  return prisma.post.findUnique({ where: { id: numId } });
}

// 依文章資料動態產生 metadata（第 13 章）
export async function generateMetadata({ params }) {
  const { id } = await params; // Next.js 15：params 是 Promise
  const post = await getPost(id);
  if (!post) return { title: "找不到文章" };

  return {
    title: post.title,
    description: post.content.slice(0, 80),
    openGraph: {
      title: post.title,
      description: post.content.slice(0, 80),
      type: "article",
    },
  };
}

export default async function PostDetailPage({ params }) {
  const { id } = await params;
  const post = await getPost(id);

  // 找不到，或該文章未發佈 → 404
  if (!post || !post.published) notFound();

  return (
    <article className="article">
      <Link href="/" className="back-link">← 回列表</Link>
      <h1>{post.title}</h1>
      <p className="muted">
        {new Date(post.createdAt).toLocaleDateString("zh-TW", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })}
      </p>
      <div className="content">{post.content}</div>
    </article>
  );
}
