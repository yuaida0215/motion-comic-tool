import { NextRequest, NextResponse } from "next/server";
import { COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

// ログアウトは状態変更なので POST のみ（GETにするとCSRFで強制ログアウトできてしまう）。
export async function POST(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
