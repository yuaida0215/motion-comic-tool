/**
 * G1 演出設計（コンテ生成）
 * ------------------------------------------------------------------
 * G0で出た shots（画像＋コマ説明＋セリフ）をもとに、各コマの
 * グレード(light/standard/advanced)・ビート(掴み/展開/余韻/転)・尺・カメラを決める。
 * 結果は人が承認画面で確認・修正してから次工程へ（レビューゲート）。
 * 口は動かさない方針なので、動きはカメラ・背景・エフェクト側で表現する。
 */
import { GATE_MODELS, visionJson } from "../anthropic";
import { loadSourceImage } from "../image";
import {
  BEATS,
  CAMERA_TYPES,
  GRADES,
  type Beat,
  type CameraType,
  type Grade,
  type Project,
} from "../schema";
import {
  BACKGROUND_THEMES,
  PANEL_FRAME_PRESETS,
  PRESET_LIBRARY_VERSION,
  TRANSITION_KITS,
  enumKeys,
  resolveFramePreset,
} from "../presets";

// 演出B：enum はプリセットライブラリのキーから生成（プリセット追加で候補が自動で増える）。
const THEME_KEYS = enumKeys(BACKGROUND_THEMES);
const FRAME_KEYS = enumKeys(PANEL_FRAME_PRESETS);
const TRANS_KEYS = enumKeys(TRANSITION_KITS);

const G1_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    theme: { type: "string", enum: THEME_KEYS, description: "ページ全体の既定の背景テーマ（ムードに合わせる）" },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          grade: { type: "string", enum: [...GRADES] },
          beat: { type: "string", enum: [...BEATS] },
          duration_sec: { type: "number" },
          camera_type: { type: "string", enum: [...CAMERA_TYPES] },
          camera_reason: { type: "string" },
          background_theme: { type: "string", enum: THEME_KEYS, description: "このコマの背景テーマ。基本はページ既定と同じ、緊張/特別な場面だけ変える" },
          frame_style: { type: "string", enum: FRAME_KEYS, description: "コマの額装。色背景には soft 推奨、黒帯(letterbox_black)なら none" },
          transition: { type: "string", enum: TRANS_KEYS, description: "このコマの登場トランジション。基本 cut(なし)。場面/ビートの切れ目や衝撃の瞬間だけ white_flash/impact、回想や静かな入りは color_fade。多用しない" },
        },
        required: ["id", "grade", "beat", "duration_sec", "camera_type", "camera_reason", "background_theme", "frame_style", "transition"],
      },
    },
    notes: { type: "string" },
  },
  required: ["theme", "shots", "notes"],
};

type G1Response = {
  theme: string;
  shots: Array<{
    id: string;
    grade: Grade;
    beat: Beat;
    duration_sec: number;
    camera_type: CameraType;
    camera_reason: string;
    background_theme: string;
    frame_style: string;
    transition: string;
  }>;
  notes: string;
};

function buildPrompt(project: Project): string {
  const m = project.meta;
  const shotList = project.shots
    .map((s) => {
      const lines = s.bubbles
        .map((b) => `      - (${b.kind}) ${b.text || "（無音）"}`)
        .join("\n");
      return `  - ${s.id}: ${s.description || "（説明なし）"}\n    セリフ:\n${lines || "      - なし"}`;
    })
    .join("\n");

  const policy =
    m.grade_policy === "auto"
      ? "auto（コマの視覚的な強さで自動仕分け）"
      : `${m.grade_policy} を既定にしつつ、必要なら個別調整可`;

  const themeVocab = Object.values(BACKGROUND_THEMES)
    .map((t) => `      - ${t.id}: ${t.label}（${t.mood}）`)
    .join("\n");
  const frameVocab = Object.entries(PANEL_FRAME_PRESETS)
    .map(([id, f]) => `      - ${id}: ${f.label}（${f.mood}）`)
    .join("\n");
  const transVocab = Object.values(TRANSITION_KITS)
    .map((t) => `      - ${t.id}: ${t.label}`)
    .join("\n");

  return `添付はこのマンガページ全体です。下のコマ一覧（G0で検出済み）に対して「動くサンプル動画」のコンテを設計してください。

配信先: ${m.delivery} ／ 目標尺: 約${m.target_duration_sec}秒 ／ グレード方針: ${policy}

コマ一覧:
${shotList}

各コマ(shot)について次を決める:
- grade: light=コマ送り＋ズーム/パン程度（静止の"間"） / standard=寄り＋エフェクト＋文字出現（会話の山場） / advanced=カメラワーク＋パララックス＋強エフェクト（疾走・アクション）。
- beat: 掴み / 展開 / 余韻 / 転 のいずれか（ページ全体の流れの中での役割）。
- duration_sec: そのコマの尺(秒)。全コマの合計が目標尺(約${m.target_duration_sec}秒)に近くなるように配分（後でセリフ実尺で微調整するので概算でよい）。セリフが多いコマは長め、無音の"間"は短め。
- camera_type: zoom_in=寄り/強調・感情 / pan=見回し・移動・状況説明 / shake=衝撃・疾走 / static=静止の間。コマ内容に合うものを選ぶ。
- camera_reason: なぜそのカメラ/グレードにしたか短い日本語の理由。
- background_theme: このコマの背景テーマ（黒帯やめて気分の色背景に額装する）。次から選ぶ:
${themeVocab}
- frame_style: コマの額装（色背景にコマを浮かせる枠の付け方）。次から選ぶ:
${frameVocab}
- transition: このコマの登場トランジション（場面転換の演出）。次から選ぶ:
${transVocab}

背景・額装・トランジションの方針:
- まず theme（ページ全体の既定の背景テーマ）を作品トーンに合わせて1つ選ぶ。各コマの background_theme は基本これと同じにし、**緊張・衝撃・特別な場面だけ**別テーマ（例: action_speed）に変える。
- frame_style は、色背景テーマのコマは soft（必要なら card/tilt）、背景が letterbox_black（黒帯）のコマは none。
- 黒帯のまま素っ気なくしない＝原則どれかの色テーマ＋soft額装で「番組」らしくする（モノクロ原画でも色背景に映える）。
- transition は**基本 cut（なし）**。場面/ビートの切れ目や衝撃のコマだけ white_flash か impact、回想・静かな入り口は color_fade。多用すると五月蝿いので**1ページで効かせるのは2〜3コマ程度**に絞る。

重要: 口は動かさない（リップシンク無し）。喋りは「吹き出しの順次出現＋音声」で表現する前提なので、動きはカメラ・背景・エフェクトで付ける。人物そのものは静止。
notes には、ページ全体の演出方針（選んだ背景テーマの理由を含む）を2〜3文で。
shots の id は上のコマ一覧の id をそのまま使うこと。`;
}

export async function gateG1(
  project: Project
): Promise<{ api_cost: number; note: string }> {
  if (project.shots.length === 0) {
    throw new Error("先にG0（コマ検出）を実行してください（shotsが空です）");
  }

  const img = await loadSourceImage(project);
  const { data, costUsd } = await visionJson({
    model: GATE_MODELS.G1,
    system:
      "あなたはモーションコミックの演出家です。各コマに尺・カメラ・グレード・ビートを与え、無理のないテンポのコンテを作ります。指定スキーマに厳密に従ってください。",
    prompt: buildPrompt(project),
    image: { data: img.data, mediaType: img.mediaType },
    jsonSchema: G1_JSON_SCHEMA,
  });

  const resp = data as G1Response;
  // 演出B：ページ既定テーマ＋プリセット版を刻む（再現性）。
  if (resp.theme && BACKGROUND_THEMES[resp.theme]) project.meta.theme = resp.theme;
  project.meta.preset_library_version = PRESET_LIBRARY_VERSION;

  // 演出D/E：冒頭カードは「自動生成しない」。
  // 以前は intro_title/intro_narration をG1に作らせていたが、ナレを創作（ハルシネーション）して
  // 「冒頭の文字列がおかしい」原因になった。カードは承認画面で人が必要な時だけ手動追加する方式にする。
  // （既存の手動カードには触れない。）
  const byId = new Map((resp.shots ?? []).map((s) => [s.id, s]));
  let applied = 0;
  for (const shot of project.shots) {
    const plan = byId.get(shot.id);
    if (!plan) continue;
    shot.grade = plan.grade;
    shot.beat = plan.beat;
    shot.duration_sec = Math.round(plan.duration_sec * 10) / 10;
    // G1の尺は「自動の仮置き」なので手動判定をリセット→次のG3で必ずセリフ実尺にフィットさせる。
    shot.duration_auto_sec = null;
    shot.camera = { type: plan.camera_type, params: { reason: plan.camera_reason } };
    // 演出B：背景テーマ（ページ既定と同じなら継承＝""）＋額装プリセット→数値展開。
    const bt = plan.background_theme && BACKGROUND_THEMES[plan.background_theme] ? plan.background_theme : "";
    shot.background = { theme: bt === project.meta.theme ? "" : bt, override_colors: [] };
    shot.panel_style = resolveFramePreset(plan.frame_style);
    // 演出C：登場トランジション（未知kitは cut）。長さ/色はプリセット既定（0/null）。
    const kit = plan.transition && TRANSITION_KITS[plan.transition] ? plan.transition : "cut";
    shot.transition_in = { kit, dur_sec: 0, color: null };
    applied++;
  }

  const total = project.shots.reduce((t, s) => t + (s.duration_sec ?? 0), 0);
  return {
    api_cost: costUsd,
    note: `コンテ適用 ${applied}/${project.shots.length}コマ / 合計尺≈${total.toFixed(1)}s / model=${GATE_MODELS.G1}`,
  };
}
