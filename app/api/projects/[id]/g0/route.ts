import { NextResponse } from "next/server";
import { runGate } from "@/lib/projects";
import { gateG0 } from "@/lib/gates/g0";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = await runGate(params.id, "G0", (p) => gateG0(p));
    return NextResponse.json({ ok: true, project });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
