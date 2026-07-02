/**
 * 演出プリセット（コード常駐ライブラリ）。
 * ------------------------------------------------------------------
 * 「演出テンプレ」(docs/演出テンプレ設計.md) の心臓部。背景テーマ等のプリセットを id で定義し、
 * **G1 の json_schema の enum も承認UIの <select> も Object.keys(...) から生成**する。
 * → プリセットを足すだけで「Claudeが選べる候補」と「UIの選択肢」が同時に増える。
 *
 * このファイルは純データ＋ヘルパのみ（node依存なし）。server / Remotion / client から共通import可。
 * project.json には id 文字列だけが入り、実体はここ＝小さく人が読めるJSONを保つ。
 */

/** プリセットライブラリの版。構造や既定を変えたら上げ、project.meta.preset_library_version に刻む。 */
export const PRESET_LIBRARY_VERSION = 1;

/* =====================================================================
 * 背景テーマ（デバイスB：黒帯やめてコマを気分の色背景に額装）
 * ===================================================================== */

export type BgFill = {
  /** solid=単色 / linear=線形グラデ / radial=放射グラデ */
  kind: "solid" | "linear" | "radial";
  /** CSSカラー。solidは先頭1色、グラデは2色以上。 */
  colors: string[];
  /** linear の角度(deg)。既定180=上→下。 */
  angleDeg?: number;
};

export type BgTheme = {
  id: string;
  /** 承認UIのラベル（日本語）。 */
  label: string;
  fill: BgFill;
  /** 雰囲気タグ（G1が「ムード→テーマ」を選ぶ手がかり）。 */
  mood: string;
};

/**
 * 既定の背景テーマ群。**"letterbox_black" が既定＝従来の #000 黒帯**（後方互換）。
 * 参照作品（少女漫画トーン）に寄せて shoujo_pink を用意。アクションは赤系。
 */
export const BACKGROUND_THEMES: Record<string, BgTheme> = {
  letterbox_black: {
    id: "letterbox_black",
    label: "黒帯（従来）",
    fill: { kind: "solid", colors: ["#000000"] },
    mood: "無地・従来どおり",
  },
  shoujo_pink: {
    id: "shoujo_pink",
    label: "少女漫画ピンク",
    fill: { kind: "linear", colors: ["#ffe3ee", "#ffc2d8"], angleDeg: 160 },
    mood: "明るい・かわいい・恋愛・嬉しい",
  },
  warm_gradient: {
    id: "warm_gradient",
    label: "暖色グラデ",
    fill: { kind: "linear", colors: ["#fff3e0", "#ffd9a8"], angleDeg: 160 },
    mood: "あたたかい・日常・ほのぼの",
  },
  cool_flat: {
    id: "cool_flat",
    label: "寒色フラット",
    fill: { kind: "solid", colors: ["#e9f0f6"] },
    mood: "静か・クール・シリアス・落ち着き",
  },
  paper_cream: {
    id: "paper_cream",
    label: "紙クリーム",
    fill: { kind: "solid", colors: ["#f7f1e3"] },
    mood: "ナチュラル・回想・やわらかい",
  },
  action_speed: {
    id: "action_speed",
    label: "アクション赤",
    fill: { kind: "radial", colors: ["#ff6b6b", "#b81e1e"] },
    mood: "緊張・衝撃・疾走・怒り",
  },
};

/* =====================================================================
 * 額装プリセット（デバイスB：コマの枠の付け方）。schema の PanelStyle 数値に展開する。
 * G1 は frame_style の id を選ぶだけ → 数値へ展開して保存（人は数値も微調整可）。
 * ===================================================================== */

export type PanelStylePreset = {
  inset_pct: number;
  radius: number;
  rotation_deg: number;
  shadow: boolean;
  border_color: string;
  border_px: number;
};

export const PANEL_FRAME_PRESETS: Record<string, { label: string; mood: string; style: PanelStylePreset }> = {
  none: {
    label: "額装なし（従来）",
    mood: "黒帯/画面いっぱい・従来どおり",
    style: { inset_pct: 0, radius: 0, rotation_deg: 0, shadow: false, border_color: "#ffffff", border_px: 0 },
  },
  soft: {
    label: "ソフト（余白＋影）",
    mood: "色背景にコマを浮かせる標準の額装",
    style: { inset_pct: 4, radius: 10, rotation_deg: 0, shadow: true, border_color: "#ffffff", border_px: 0 },
  },
  card: {
    label: "カード（白枠）",
    mood: "白枠つきで写真/カードのように見せる",
    style: { inset_pct: 7, radius: 16, rotation_deg: 0, shadow: true, border_color: "#ffffff", border_px: 6 },
  },
  tilt: {
    label: "傾き",
    mood: "軽い傾きで動き・遊び心",
    style: { inset_pct: 7, radius: 14, rotation_deg: -2, shadow: true, border_color: "#ffffff", border_px: 0 },
  },
};

/** frame_style id → PanelStyle 数値（未知idは none）。 */
export function resolveFramePreset(id: string | null | undefined): PanelStylePreset {
  return (id && PANEL_FRAME_PRESETS[id]?.style) || PANEL_FRAME_PRESETS.none.style;
}

/* =====================================================================
 * トランジション（デバイスC：場面転換）。各コマの「登場」に1枚オーバーレイを重ねる方式。
 * cut=何もしない（従来の即切替＝後方互換）。
 * ===================================================================== */

export type TransKit = {
  id: string;
  label: string;
  /** none=なし / flash=色フィルがフェードアウト / fade=色から立ち上げ / wipe=色幕がワイプして退く / impact=瞬間フラッシュ＋寄り */
  kind: "none" | "flash" | "fade" | "wipe" | "impact";
  /** 既定の長さ(秒)。shot側で上書き可。 */
  durSec: number;
  /** 既定の色。 */
  color: string;
};

export const TRANSITION_KITS: Record<string, TransKit> = {
  cut: { id: "cut", label: "なし（即切替）", kind: "none", durSec: 0, color: "#000000" },
  white_flash: { id: "white_flash", label: "白フラッシュ", kind: "flash", durSec: 0.3, color: "#ffffff" },
  color_fade: { id: "color_fade", label: "黒からフェード", kind: "fade", durSec: 0.45, color: "#000000" },
  wipe: { id: "wipe", label: "ワイプ", kind: "wipe", durSec: 0.4, color: "#000000" },
  impact: { id: "impact", label: "インパクト（衝撃）", kind: "impact", durSec: 0.22, color: "#ffffff" },
};

/** トランジションキット解決（未知idは cut）。 */
export function resolveTransitionKit(id: string | null | undefined): TransKit {
  const t = id && Object.prototype.hasOwnProperty.call(TRANSITION_KITS, id) ? TRANSITION_KITS[id] : undefined;
  return t || TRANSITION_KITS.cut;
}

/* =====================================================================
 * カードテンプレート（デバイスD/E：タイトル/アイキャッチ/ナレーション文字カード）。
 * project.cards[] は template id を参照し、実体（背景・文字スタイル・登場の仕方）はここ。
 * ===================================================================== */

export type CardTextStyle = {
  /** フォントサイズ（画面高さに対する%）。 */
  sizePct: number;
  color: string;
  weight: number;
  align: "left" | "center" | "right";
  /** 縦書き(vertical)/横書き(horizontal)。 */
  writingMode: "horizontal" | "vertical";
};
export type CardTemplate = {
  id: string;
  label: string;
  role: "title" | "eyecatch" | "narration";
  /** 背景テーマ id（BACKGROUND_THEMES）。 */
  bg: string;
  textStyle: CardTextStyle;
  /** 登場アニメ。fade=フェード / slide=下から / typewriter（将来）。 */
  enter: "fade" | "slide" | "typewriter";
};

export const CARD_TEMPLATES: Record<string, CardTemplate> = {
  title_default: {
    id: "title_default",
    label: "タイトル（黒地・白文字）",
    role: "title",
    bg: "letterbox_black",
    textStyle: { sizePct: 8, color: "#ffffff", weight: 800, align: "center", writingMode: "horizontal" },
    enter: "fade",
  },
  title_light: {
    id: "title_light",
    label: "タイトル（クリーム地・濃文字）",
    role: "title",
    bg: "paper_cream",
    textStyle: { sizePct: 8, color: "#23201a", weight: 800, align: "center", writingMode: "horizontal" },
    enter: "fade",
  },
  eyecatch_pop: {
    id: "eyecatch_pop",
    label: "アイキャッチ（ピンク・ポップ）",
    role: "eyecatch",
    bg: "shoujo_pink",
    textStyle: { sizePct: 9, color: "#d23c77", weight: 900, align: "center", writingMode: "horizontal" },
    enter: "slide",
  },
  narration_plain: {
    id: "narration_plain",
    label: "ナレ（クリーム地・縦書き）",
    role: "narration",
    bg: "paper_cream",
    textStyle: { sizePct: 4.6, color: "#23201a", weight: 500, align: "center", writingMode: "vertical" },
    enter: "fade",
  },
  narration_dark: {
    id: "narration_dark",
    label: "ナレ（黒地・白・横書き）",
    role: "narration",
    bg: "letterbox_black",
    textStyle: { sizePct: 4.6, color: "#f5f5f5", weight: 500, align: "center", writingMode: "horizontal" },
    enter: "fade",
  },
};

/** カードテンプレートを解決（未知idはタイトル既定にフォールバック）。 */
export function resolveCardTemplate(id: string | null | undefined): CardTemplate {
  const t = id && Object.prototype.hasOwnProperty.call(CARD_TEMPLATES, id) ? CARD_TEMPLATES[id] : undefined;
  return t || CARD_TEMPLATES.title_default;
}

/* =====================================================================
 * ヘルパ
 * ===================================================================== */

/** ライブラリのキー一覧（G1スキーマのenum・UIの<select>の元）。 */
export const enumKeys = (lib: Record<string, unknown>): string[] => Object.keys(lib);

/** 背景テーマを解決（未知id/プロトタイプ汚染は黒帯にフォールバック＝壊れない）。
 *  ※ `in`/添字は Object.prototype のキー("toString"等)を拾うので、自前プロパティ＋.fill実在で判定する。 */
export function resolveBgTheme(id: string | null | undefined): BgTheme {
  const t = id && Object.prototype.hasOwnProperty.call(BACKGROUND_THEMES, id) ? BACKGROUND_THEMES[id] : undefined;
  return t && t.fill ? t : BACKGROUND_THEMES.letterbox_black;
}

/** BgFill → CSS background 文字列。 */
export function bgFillToCss(fill: BgFill): string {
  if (fill.kind === "linear")
    return `linear-gradient(${fill.angleDeg ?? 180}deg, ${fill.colors.join(", ")})`;
  if (fill.kind === "radial")
    return `radial-gradient(circle at 50% 42%, ${fill.colors.join(", ")})`;
  return fill.colors[0] || "#000000";
}
