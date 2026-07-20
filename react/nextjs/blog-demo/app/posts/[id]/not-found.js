import Link from "next/link";

export default function NotFound() {
  return (
    <main className="wrap">
      <h1>找不到這篇文章</h1>
      <p className="muted">它可能不存在，或尚未發佈。</p>
      <Link href="/" className="back-link">← 回首頁</Link>
    </main>
  );
}
