import { NextResponse } from "next/server";
import { getProject } from "@/lib/projects";

export const runtime = "nodejs";
// GETをNext.jsの静的キャッシュ対象にしない（毎回ストレージの最新状態を返す）。
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const project = await getProject(params.id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
}
