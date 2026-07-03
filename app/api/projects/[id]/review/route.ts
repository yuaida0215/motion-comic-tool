import { NextResponse } from "next/server";
import { getProject, saveProject, setGateState } from "@/lib/projects";
import { orderByReadingOrder } from "@/lib/panelOrder";
import {
  BeatSchema,
  BubbleKindSchema,
  CameraTypeSchema,
  CARD_ROLES,
  DeliverySchema,
  FramingSchema,
  GradeSchema,
  ShotSchema,
  type Shot,
} from "@/lib/schema";
import { BACKGROUND_THEMES, CARD_TEMPLATES, PANEL_FRAME_PRESETS, TRANSITION_KITS, resolveFramePreset } from "@/lib/presets";

/** 次の未使用の shot_NN id を発番（既存の最大番号+1。欠番があっても衝突しない）。 */
function nextShotId(project: { shots: Array<{ id: string }> }): string {
  let max = 0;
  for (const s of project.shots) {
    const m = /^shot_(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `shot_${String(max + 1).padStart(2, "0")}`;
}

/** 指定ページのコマだけを読み順(右上→左、上→下)に並べ替えて配列に書き戻す（他ページの位置は変えない）。 */
function resortPage(shots: Shot[], pageId: string): Shot[] {
  const idxs: number[] = [];
  const group: Shot[] = [];
  shots.forEach((s, i) => {
    if ((s.page_id || "") === pageId) {
      idxs.push(i);
      group.push(s);
    }
  });
  if (group.length < 2) return shots;
  const sorted = orderByReadingOrder(group, (s) => s.bbox);
  const next = [...shots];
  idxs.forEach((i, k) => {
    next[i] = sorted[k];
  });
  return next;
}

export const runtime = "nodejs";

/**
 * G1のレビューゲート: 人が直したコンテ/OCRを保存し、必要なら承認する。
 * body: { shots?: 編集内容[], approve?: boolean }
 *   - 座標(bbox)はこのMVPでは編集対象外。text/kind/grade/beat/尺/カメラ種別を更新。
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const body = (await req.json().catch(() => ({}))) as {
    shots?: Array<{
      id: string;
      description?: string;
      grade?: string;
      beat?: string;
      duration_sec?: number;
      camera_type?: string;
      framing?: string;
      background_theme?: string; // 演出B：""=テーマ継承 / プリセットid
      frame_style?: string; // 演出B：額装プリセットid
      transition?: string; // 演出C：登場トランジションkit
      mouth_off?: boolean; // 口パク：このコマは口パクしない（素材保持・静止）
      bbox?: number[];
      // 丸ごと差し替え（cardsと同じ方式）＝人がコマ内で吹き出しを追加/削除したのをそのまま反映する。
      // サーバー生成済みフィールド(erased_img等)はクライアントが持ち回って一緒に送ってくる。
      bubbles?: Array<{
        text?: string;
        kind?: string;
        speaker?: string | null;
        emotion?: string;
        bbox?: number[] | null;
        sfx_prompt?: string;
        erased_img?: string | null;
        erase_box?: number[] | null;
        reveal_timing?: { start?: number; end?: number } | null;
      }>;
    }>;
    voice_cast?: Record<
      string,
      { voice_id?: string; speed?: number; pitch?: number; tone?: string; age?: string }
    >;
    delivery?: string;
    theme?: string; // 演出B：プロジェクト既定の背景テーマ
    cards?: Array<{
      id?: string;
      role?: string;
      template?: string;
      at_start?: boolean;
      after_shot?: string | null;
      dur_sec?: number;
      lines?: string[];
    }>; // 演出D/E：文字カード（丸ごと差し替え）
    approve?: boolean;
    // コマ割りの手動修正（G0の検出漏れ/誤検出を人が補う）。
    add_shot?: { page_id?: string; bbox?: number[] }; // 新しいコマを1つ追加（位置は追加後にドラッグで合わせる想定）
    delete_shot_id?: string; // 誤検出コマを1つ削除（吹き出し/音声/口パク素材ごと消える＝取り消し不可）
    resort_reading_order?: boolean; // 全ページのコマを現在のbboxから読み順に自動整列（手動追加/移動の後の並び直し用）
    move_shot?: { id?: string; dir?: string }; // 読み順を1つ前(up)/後ろ(down)へ。幾何学の自動判定が正解と違う変則レイアウト用
  };

  const validBox = (b: unknown): b is [number, number, number, number] =>
    Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === "number" && isFinite(n));

  const project = await getProject(params.id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // コマ割りの手動修正：追加・削除・読み順の自動整列。
  // 単発の明示的な操作として扱う（bubbles/cardsのような「配列を丸ごと差し替え」方式にしないのは、
  // shotはmouth/voice/layers等サーバー生成の入れ子データを大量に持つため、クライアントに全件を
  // 正しく持ち回らせるのは事故りやすい＝過去に実際にbboxを消してしまう事故があった）。
  if (body.add_shot && validBox(body.add_shot.bbox)) {
    const page_id = typeof body.add_shot.page_id === "string" ? body.add_shot.page_id : "";
    const newShot = ShotSchema.parse({
      id: nextShotId(project),
      bbox: body.add_shot.bbox.map((n) => Math.round(n)),
      page_id,
      description: "",
      bubbles: [],
    });
    // 同じページのコマの末尾に挿入（他ページの並びは変えない）。位置はこの後ドラッグで合わせる想定。
    let insertAt = project.shots.length;
    for (let i = project.shots.length - 1; i >= 0; i--) {
      if ((project.shots[i].page_id || "") === page_id) {
        insertAt = i + 1;
        break;
      }
    }
    project.shots.splice(insertAt, 0, newShot);
    await saveProject(project);
  }

  if (typeof body.delete_shot_id === "string" && body.delete_shot_id) {
    const before = project.shots.length;
    project.shots = project.shots.filter((s) => s.id !== body.delete_shot_id);
    if (project.shots.length !== before) {
      // このコマを指していた文字カードの「このコマの後」参照が孤立しないよう外す（末尾配置にフォールバック）。
      project.cards = (project.cards ?? []).map((c) =>
        c.after_shot === body.delete_shot_id ? { ...c, after_shot: null, at_start: true } : c
      );
      await saveProject(project);
    }
  }

  if (body.resort_reading_order) {
    const pageIds = [...new Set(project.shots.map((s) => s.page_id || ""))];
    let next = project.shots;
    for (const pid of pageIds) next = resortPage(next, pid);
    project.shots = next;
    await saveProject(project);
  }

  // 読み順の手動並べ替え：隣と入れ替えるだけ（同じページ内に限定＝ページまたぎの並びは崩さない）。
  // 右列を縦に読み切ってから左へ移る等、bboxの幾何学だけでは正解が決まらない変則レイアウトの補正用。
  // shot idは変えない（音声/画像アセットがidに紐づくため）。動画のコマ順は配列順で決まる。
  if (body.move_shot && typeof body.move_shot.id === "string" && (body.move_shot.dir === "up" || body.move_shot.dir === "down")) {
    const i = project.shots.findIndex((s) => s.id === body.move_shot!.id);
    const j = body.move_shot.dir === "up" ? i - 1 : i + 1;
    if (
      i >= 0 &&
      j >= 0 &&
      j < project.shots.length &&
      (project.shots[i].page_id || "") === (project.shots[j].page_id || "")
    ) {
      const tmp = project.shots[i];
      project.shots[i] = project.shots[j];
      project.shots[j] = tmp;
      await saveProject(project);
    }
  }

  if (Array.isArray(body.shots)) {
    const byId = new Map(project.shots.map((s) => [s.id, s]));
    for (const edit of body.shots) {
      const shot = byId.get(edit.id);
      if (!shot) continue;
      if (typeof edit.description === "string") shot.description = edit.description;
      if (edit.grade && GradeSchema.safeParse(edit.grade).success)
        shot.grade = edit.grade as typeof shot.grade;
      if (edit.beat && BeatSchema.safeParse(edit.beat).success)
        shot.beat = edit.beat as typeof shot.beat;
      if (typeof edit.duration_sec === "number" && edit.duration_sec >= 0)
        shot.duration_sec = edit.duration_sec;
      if (edit.camera_type && CameraTypeSchema.safeParse(edit.camera_type).success)
        shot.camera.type = edit.camera_type as typeof shot.camera.type;
      if (edit.framing && FramingSchema.safeParse(edit.framing).success)
        shot.framing = edit.framing as typeof shot.framing;
      // 演出B：背景テーマ（""=テーマ継承、またはライブラリの自前キー）。
      // ※ `in` は Object.prototype のキー("toString"等)を通すので hasOwnProperty で判定。
      if (
        typeof edit.background_theme === "string" &&
        (edit.background_theme === "" || Object.prototype.hasOwnProperty.call(BACKGROUND_THEMES, edit.background_theme))
      )
        shot.background = { ...shot.background, theme: edit.background_theme };
      // 演出B：額装プリセット → PanelStyle 数値へ展開
      if (typeof edit.frame_style === "string" && Object.prototype.hasOwnProperty.call(PANEL_FRAME_PRESETS, edit.frame_style))
        shot.panel_style = resolveFramePreset(edit.frame_style);
      // 演出C：登場トランジションkit
      if (typeof edit.transition === "string" && Object.prototype.hasOwnProperty.call(TRANSITION_KITS, edit.transition))
        shot.transition_in = { ...shot.transition_in, kit: edit.transition };
      // 口パク：このコマは口パクしない（素材は残し disabled で静止＝可逆）
      if (typeof edit.mouth_off === "boolean" && shot.mouth) shot.mouth.disabled = edit.mouth_off;
      if (validBox(edit.bbox))
        shot.bbox = edit.bbox.map((n) => Math.round(n)) as [number, number, number, number];
      if (Array.isArray(edit.bubbles)) {
        // 丸ごと差し替え：既存bubbleへのパッチではなく配列そのものを置き換える。
        // これで人が追加/削除した吹き出しがそのまま反映される（パッチ方式だと配列長が
        // 変わった時に新規分が無視されたり、削除がインデックスずれで別の吹き出しに
        // 誤って上書きされたりする）。
        shot.bubbles = edit.bubbles.map((be) => ({
          text: typeof be.text === "string" ? be.text : "",
          kind:
            be.kind && BubbleKindSchema.safeParse(be.kind).success
              ? (be.kind as (typeof shot.bubbles)[number]["kind"])
              : "speech",
          bbox: validBox(be.bbox) ? (be.bbox.map((n) => Math.round(n)) as [number, number, number, number]) : null,
          speaker: typeof be.speaker === "string" ? be.speaker : null,
          emotion: typeof be.emotion === "string" ? be.emotion : "",
          sfx_prompt: typeof be.sfx_prompt === "string" ? be.sfx_prompt : "",
          erased_img: typeof be.erased_img === "string" ? be.erased_img : null,
          erase_box: validBox(be.erase_box)
            ? (be.erase_box.map((n) => Math.round(n)) as [number, number, number, number])
            : null,
          reveal_timing:
            be.reveal_timing &&
            typeof be.reveal_timing.start === "number" &&
            typeof be.reveal_timing.end === "number"
              ? { start: be.reveal_timing.start, end: be.reveal_timing.end }
              : null,
        }));
      }
    }
    await saveProject(project);
  }

  if (body.voice_cast && typeof body.voice_cast === "object") {
    // 削除を反映するため voice_cast は丸ごと差し替える（クライアントは常に全件送る）
    const next: Record<
      string,
      { voice_id: string; speed: number; pitch: number; tone: string; age: string }
    > = {};
    for (const [sid, v] of Object.entries(body.voice_cast)) {
      next[sid] = {
        voice_id: typeof v.voice_id === "string" ? v.voice_id : "f_calm",
        speed: typeof v.speed === "number" ? v.speed : 1.0,
        pitch: typeof v.pitch === "number" ? v.pitch : 0,
        tone: typeof v.tone === "string" ? v.tone : "normal",
        age: typeof v.age === "string" ? v.age : "standard",
      };
    }
    project.voice_cast = next;
    await saveProject(project);
  }

  if (body.delivery && DeliverySchema.safeParse(body.delivery).success) {
    project.meta.delivery = body.delivery as typeof project.meta.delivery;
    await saveProject(project);
  }

  // 演出B：プロジェクト既定の背景テーマ
  if (typeof body.theme === "string" && Object.prototype.hasOwnProperty.call(BACKGROUND_THEMES, body.theme)) {
    project.meta.theme = body.theme;
    await saveProject(project);
  }

  // 演出D/E：文字カード（丸ごと差し替え＝削除を反映。各カードはサニタイズ）
  if (Array.isArray(body.cards)) {
    const shotIds = new Set(project.shots.map((s) => s.id));
    project.cards = body.cards.map((c, i) => {
      const role = typeof c.role === "string" && (CARD_ROLES as readonly string[]).includes(c.role) ? c.role : "title";
      const template =
        typeof c.template === "string" && Object.prototype.hasOwnProperty.call(CARD_TEMPLATES, c.template)
          ? c.template
          : "title_default";
      const after_shot = typeof c.after_shot === "string" && shotIds.has(c.after_shot) ? c.after_shot : null;
      const at_start = typeof c.at_start === "boolean" ? c.at_start : !after_shot;
      const dur_sec = typeof c.dur_sec === "number" && c.dur_sec > 0 ? c.dur_sec : 2.5;
      const lines = Array.isArray(c.lines) ? c.lines.filter((l) => typeof l === "string") : [];
      return {
        id: typeof c.id === "string" && c.id ? c.id : `card_${i}`,
        role: role as "title" | "eyecatch" | "narration",
        template,
        at_start,
        after_shot,
        dur_sec,
        lines,
        logo_asset: null,
        narration_voice: null,
      };
    });
    await saveProject(project);
  }

  let result = project;
  if (body.approve) {
    result = await setGateState(params.id, "G1", { state: "done", approved: true });
  }

  return NextResponse.json({ ok: true, project: result });
}
