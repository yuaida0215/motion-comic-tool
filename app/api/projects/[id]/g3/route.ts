import { NextResponse } from "next/server";
import { runGate } from "@/lib/projects";
import { gateG3 } from "@/lib/gates/g3";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = await runGate(params.id, "G3", (p) => gateG3(p));
    return NextResponse.json({ ok: true, project });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
