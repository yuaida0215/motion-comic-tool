import { NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/projects";
import { detectMouths, generateOpenMouth } from "@/lib/mouth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 口パク素材の生成。
 *  - body なし: 全話者コマの口検出 → 開き口を一括生成（コマ数が多いと maxDuration を超えうる）。
 *  - body {detect_only:true}: 口検出だけ実行して保存（コマ数が多い時の分割実行用。この後 {shot_id} で順次生成）。
 *  - body {shot_id}: そのコマの開き口だけ生成/作り直し（要・事前検出）。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as { shot_id?: string; detect_only?: boolean };
  const project = await getProject(params.id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const t0 = Date.now();
  let cost = 0;
  let note = "";
  const errors: string[] = [];

  if (body.detect_only) {
    const det = await detectMouths(project);
    cost += det.api_cost;
    const targets = project.shots.filter(
      (s) => s.mouth && (s.mouth.facing === "front" || s.mouth.facing === "side")
    );
    note = `口検出のみ ${det.detected}（生成対象=facing front/side: ${targets.map((s) => s.id).join(",") || "なし"}）`;
  } else if (body.shot_id) {
    try {
      await generateOpenMouth(project, body.shot_id);
      note = `開き口 再生成（${body.shot_id}）`;
    } catch (e) {
      errors.push(`${body.shot_id}: ${String(e).slice(0, 120)}`);
    }
  } else {
    const det = await detectMouths(project);
    cost += det.api_cost;
    const targets = project.shots.filter(
      (s) => s.mouth && (s.mouth.facing === "front" || s.mouth.facing === "side")
    );
    // コマ単位は逐次（コマ内で2モード×best-of-N のFLUX呼び出しが走るので、並列だとレート制限/コストバーストになる）
    for (const s of targets) {
      try {
        await generateOpenMouth(project, s.id);
      } catch (e) {
        errors.push(`${s.id}: ${String(e).slice(0, 120)}`);
      }
    }
    const ok = targets.filter((s) => s.mouth?.open_img && s.mouth?.closed_img).length;
    const withHalf = targets.filter((s) => s.mouth?.half_img).length;
    note = `口検出 ${det.detected}（話者コマ）／口パク生成 ${ok}/${targets.length}（FLUX Fillインペイント・閉/半/開の3段階・うち半開きあり ${withHalf}・音量で開閉）`;
  }

  project.cost_log.push({
    gate: "MOUTH",
    elapsed_sec: Math.round((Date.now() - t0) / 100) / 10,
    api_cost: Math.round(cost * 1e6) / 1e6,
    note,
    at: new Date().toISOString(),
  });
  await saveProject(project);

  return NextResponse.json({ ok: true, project, note, errors });
}
