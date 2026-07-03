/**
 * スキーマの自己テスト。`npm run schema:check` で実行。
 *  - 空プロジェクトを生成 → 再検証して整合性を確認
 *  - 各ゲートの「書き足し」が型に通ることを最小限サンプルで確認
 * ブラウザを使わず、スキーマ単体が壊れていないかを素早く確かめる用途。
 */
import {
  createEmptyProject,
  parseProject,
  ProjectSchema,
  type Project,
} from "../lib/schema";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok -", msg);
}

console.log("[1] 空プロジェクト生成");
const p: Project = createEmptyProject({
  project_id: "test01",
  source_image: "page01.png",
  created_at: new Date().toISOString(),
  title: "テスト",
});
assert(p.meta.project_id === "test01", "project_id が設定される");
assert(p.meta.grade_policy === "auto", "grade_policy 既定は auto（§12-1暫定）");
assert(p.shots.length === 0, "shots は空配列で始まる");
assert(p.pipeline.G1.approved === false, "G1 は未承認で始まる（レビューゲート）");

console.log("[2] 各ゲートの書き足しが通る");
p.shots.push({
  id: "shot_01",
  bbox: [0, 0, 600, 800], // G0
  page_id: "", // v3 多ページ（""=単一ページ）
  description: "二人が向かい合って話す", // G0
  grade: "standard", // G1
  beat: "展開",
  duration_sec: 4.0,
  duration_auto_sec: null, // G3
  camera: { type: "zoom_in", params: { scale: 1.2 } },
  framing: "auto", // G4
  background: { theme: "", override_colors: [] }, // 演出B
  panel_style: { inset_pct: 0, radius: 0, rotation_deg: 0, shadow: false, border_color: "#ffffff", border_px: 0 }, // 演出B
  transition_in: { kit: "cut", dur_sec: 0, color: null }, // 演出C
  bubbles: [
    {
      text: "根本的なことは…", // G0 OCR
      kind: "speech",
      bbox: [120, 60, 200, 90],
      speaker: "male_a", // G3
      emotion: "angry", // G3
      sfx_prompt: "", // G3
      erased_img: "shot01_bubble1_clean.png", // G2
      erase_box: [115, 55, 210, 100], // G2
      reveal_timing: { start: 0.2, end: 1.6 }, // G4
    },
  ],
  layers: {
    character: "shot01_char.png",
    foreground: null,
    effect: null,
    background_inpainted: "shot01_bg.png",
  }, // G2
  voice: [{ clip: "shot01_male_a.mp3", dur: 1.4, speaker: "male_a", bubble_index: 0 }], // G3
  mouth: null,
  motion_spec: {},
  sfx: [],
  bgm_ref: null,
  colorized: false,
});
const reparsed = parseProject(p);
assert(reparsed.shots[0].id === "shot_01", "shot を書き足して再検証が通る");

console.log("[3] 壊れたデータは弾く");
const bad = ProjectSchema.safeParse({ meta: { project_id: 123 } });
assert(bad.success === false, "不正なJSONは safeParse が失敗を返す");

console.log("\n✅ schema:check 全項目パス");
