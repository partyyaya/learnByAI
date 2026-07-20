import "./globals.css";
import Link from "next/link";
import ThemeToggle from "./ThemeToggle";

// 站台層級 metadata（第 13 章）：子頁只給主標，會自動套上 " | My Blog"
export const metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: {
    default: "My Blog — Next.js 全端部落格",
    template: "%s | My Blog",
  },
  description: "React 課程 Next.js 篇的期末專題：App Router + Server Actions + Prisma。",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body>
        {/* 進頁前先套用使用者偏好主題，避免閃爍 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}`,
          }}
        />
        <header className="site-header">
          <Link href="/" className="brand">My Blog</Link>
          <nav className="site-nav">
            <Link href="/">首頁</Link>
            <Link href="/admin">後台</Link>
            <ThemeToggle />
          </nav>
        </header>
        <div className="site-main">{children}</div>
        <footer className="site-footer">
          Next.js 課程期末專題 · App Router + Server Actions + Prisma
        </footer>
      </body>
    </html>
  );
}
