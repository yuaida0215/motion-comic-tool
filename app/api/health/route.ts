import { NextResponse } from "next/server";
import { GATES, SCHEMA_VERSION } from "@/lib/schema";

export const dynamic = "force-dynamic";

// 動作確認用エンドポイント。/api/health で疎通とスキーマバージョンを返す。
export function GET() {
  return NextResponse.json({
    ok: true,
    tool: "motion-comic-tool",
    schema_version: SCHEMA_VERSION,
    gates: GATES,
    mvp_scope: "G0-G4",
  });
}
