import { NextRequest, NextResponse } from "next/server";
import { COOKIE, issueToken, passwordOk, safeNext, MAX_AGE_SEC } from "@/lib/auth";

export const runtime = "nodejs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// パスワード照合 → 合致なら署名Cookieを発行して元の画面へ。
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const password = form ? String(form.get("password") ?? "") : "";
  const next = safeNext(req.nextUrl.searchParams.get("next"));

  if (!(await passwordOk(password))) {
    // 総当たり対策: 失敗時に小さな遅延（ジッタ付き）を入れて高速試行を鈍らせる
    await sleep(500 + Math.floor(Math.random() * 400));
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("e", "1");
    if (next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url, { status: 303 });
  }

  const token = await issueToken();
  if (!token) {
    // AUTH_SECRET 未設定（サーバ設定不備）
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("e", "config");
    return NextResponse.redirect(url, { status: 303 });
  }

  const res = NextResponse.redirect(new URL(next, req.url), { status: 303 });
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
  return res;
}
