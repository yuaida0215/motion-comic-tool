import { NextResponse } from "next/server";
import { runGate } from "@/lib/projects";
import { gateG4 } from "@/lib/gates/g4";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * AWS Lambda（社外・自分のマシンの外）がフェッチできる、実際に公開されているURLを解決する。
 * Vercel上では `new URL(req.url).origin` が信頼できない（内部的なホスト名や、
 * 別環境でのテスト時の値を拾ってしまうことがあり、実際に本番で "http://localhost:3100" を
 * 返してLambdaのアセット取得が全滅する事故が起きた）。Vercelが自動注入する
 * VERCEL_PROJECT_PRODUCTION_URL（本番の実ドメイン）/ VERCEL_URL（デプロイ固有URL）を優先する。
 */
function resolveBaseUrl(req: Request): string {
  if (process.env.RENDER_BASE_URL) return process.env.RENDER_BASE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return new URL(req.url).origin;
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const baseUrl = resolveBaseUrl(req);
    const project = await runGate(params.id, "G4", (p) => gateG4(p, baseUrl));
    return NextResponse.json({ ok: true, project });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
