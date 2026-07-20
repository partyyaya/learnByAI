// 第一道防護：進入 /admin 前先檢查有沒有登入 cookie（第 10 章）。
// Middleware 跑在 Edge，只做「快速判斷 + 轉址」，不查資料庫。
import { NextResponse } from "next/server";

export function middleware(request) {
  const token = request.cookies.get("token")?.value;

  if (!token) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"], // 只守後台
};
