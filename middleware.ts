import { NextRequest, NextResponse } from "next/server";
import { COOKIE, verifyToken } from "@/lib/auth";

// ログインなしで通すパス。
// /api/assets はRemotion Lambda（AWS上のレンダーワーカー）が動画書き出し中に
// 画像/音声を直接フェッチするために必要（Lambda側はログインCookieを持てない）。
// project_id は推測不能なランダムIDなので、公開しても実害は無い（署名付きURLと同等の安全性）。
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout", "/api/assets"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE)?.value;
  if (await verifyToken(token)) return NextResponse.next();

  // 未認証: APIは401、ページは /login へ（戻り先を next で保持）
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// 静的アセット以外すべてにミドルウェアを適用（APIルートも含む）。
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
