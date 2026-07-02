import { z } from "zod";

/**
 * モーションコミック自動生成ツール — プロジェクトJSONスキーマ
 * ------------------------------------------------------------------
 * 与件定義書 v1「6. プロジェクトJSON構造」をコードに落としたもの。
 *
 * 設計の背骨（与件 §2）:
 *  - 1ページ = 1プロジェクト = 1つのJSON。
 *  - 処理の最小単位は `shot`（コマ × グレード）。ページ単位にはしない。
 *  - 各ゲート(G0–G4)が、このJSONの該当フィールドを「書き足していく」。
 *  - そのため各ゲートの結果フィールドは原則オプショナル/nullable。
 *    未処理の段階では未設定 → 途中保存・途中再開・途中検査ができる。
 *
 * このファイルの値（スキーマ）はすべてのゲート/UI/Remotionレンダラから
 * 共通で import して使う「唯一の真実(single source of truth)」。
 */

/** スキーマのバージョン。構造を変えたら上げる（保存済みJSONの互換管理用）。
 *  v2: 演出レイヤー(B 色背景額装ほか) を追加。
 *  v3: 多ページ(章まるごと)対応の土台。meta.pages / shot.page_id / outputs.page_clips を追加。
 *      全フィールド既定値が現状(1ページ)を再現＝移行コード不要・既存JSONはそのまま動く。 */
export const SCHEMA_VERSION = 3;

/* =====================================================================
 * 1. 列挙(enum)定義
 * ===================================================================== */

/** 配信先（画角）— 与件 §4.1。vertical=9:16 / horizontal=16:9 / square=1:1 */
export const DELIVERIES = ["vertical", "horizontal", "square"] as const;
export const DeliverySchema = z.enum(DELIVERIES);
export type Delivery = z.infer<typeof DeliverySchema>;

/** 画角→動画サイズ(px)。 */
export const DELIVERY_SIZE: Record<Delivery, { w: number; h: number; label: string }> = {
  horizontal: { w: 1920, h: 1080, label: "16:9（横）" },
  square: { w: 1080, h: 1080, label: "1:1（正方形）" },
  vertical: { w: 1080, h: 1920, label: "9:16（縦）" },
};

/** グレード（コマ単位の処理の重さ）— 与件 §7 */
export const GRADES = ["light", "standard", "advanced"] as const;
export const GradeSchema = z.enum(GRADES);
export type Grade = z.infer<typeof GradeSchema>;

/** グレード方針（meta）= 既定グレードを固定するか、auto(自動仕分け)に任せるか */
export const GRADE_POLICIES = ["auto", "light", "standard", "advanced"] as const;
export const GradePolicySchema = z.enum(GRADE_POLICIES);
export type GradePolicy = z.infer<typeof GradePolicySchema>;

/** ビート（演出上の役割）— 与件 §6 / G1 */
export const BEATS = ["掴み", "展開", "余韻", "転"] as const;
export const BeatSchema = z.enum(BEATS);
export type Beat = z.infer<typeof BeatSchema>;

/** カメラワーク種別 — 与件 §6 / G1・G4 */
export const CAMERA_TYPES = ["zoom_in", "pan", "shake", "static"] as const;
export const CameraTypeSchema = z.enum(CAMERA_TYPES);
export type CameraType = z.infer<typeof CameraTypeSchema>;

/**
 * コマの見せ方（G4・縦/横の画面にどう収めるか）。spec例には無い実装上の追加。
 * auto=比率で自動 / fit=全体表示(レターボックス) / fill=画面を埋める(アップ・端を切る) / pan=端から端へパンして全体を見せる
 */
export const FRAMINGS = ["auto", "fit", "fill", "pan"] as const;
export const FramingSchema = z.enum(FRAMINGS);
export type Framing = z.infer<typeof FramingSchema>;

/* ---------------------------------------------------------------------
 * 演出レイヤー（docs/演出テンプレ設計.md）。プリセットの実体は lib/presets.ts。
 * project.json には id 文字列＋数値だけが入る。全て既定値が「従来どおり」を再現する。
 * ------------------------------------------------------------------- */

/** 背景テーマ（デバイスB）。theme="" は meta.theme を継承。実体は presets.ts の BACKGROUND_THEMES[theme]。 */
export const BackgroundSchema = z.object({
  /** プリセットID。"" = プロジェクト既定(meta.theme)に従う。 */
  theme: z.string().default(""),
  /** テーマの色を上書きしたいときだけ（空なら theme の色を使う）。 */
  override_colors: z.array(z.string()).default([]),
});
export type Background = z.infer<typeof BackgroundSchema>;

/** 登場トランジション（デバイスC）。kit="cut"=なし（従来の即切替＝後方互換）。実体は presets.ts の TRANSITION_KITS。 */
export const TransitionSchema = z.object({
  /** TRANSITION_KITS のキー。"cut"=なし。 */
  kit: z.string().default("cut"),
  /** 長さ(秒)。0=プリセット既定を使う。 */
  dur_sec: z.number().default(0),
  /** 色。null=プリセット既定。 */
  color: z.string().nullable().default(null),
});
export type Transition = z.infer<typeof TransitionSchema>;

/** コマの額装スタイル（デバイスB）。全0/false=従来どおり（コマが画面いっぱい・枠なし）。 */
export const PanelStyleSchema = z.object({
  /** コマ周囲の余白（画面比%）。色背景を見せる額装の余白。0=従来。 */
  inset_pct: z.number().default(0),
  /** 角丸(px)。 */
  radius: z.number().default(0),
  /** わずかな傾き(deg)。 */
  rotation_deg: z.number().default(0),
  /** ドロップシャドウ。 */
  shadow: z.boolean().default(false),
  /** 枠線の色（border_px>0のとき）。 */
  border_color: z.string().default("#ffffff"),
  /** 枠線の太さ(px)。0=枠なし。 */
  border_px: z.number().default(0),
});
export type PanelStyle = z.infer<typeof PanelStyleSchema>;

/**
 * 吹き出しの種別（G0）。喋り(speech/thought)と擬音(sfx)・ナレ(narration)を区別する。
 * G3でTTS対象を絞る（擬音は喋らせない）ために使う。spec例には無い補助フィールド。
 */
export const BUBBLE_KINDS = ["speech", "thought", "narration", "scream", "sfx", "other"] as const;
export const BubbleKindSchema = z.enum(BUBBLE_KINDS);
export type BubbleKind = z.infer<typeof BubbleKindSchema>;

/** ゲート識別子（MVPスコープ = G0–G4）— 与件 §5 */
export const GATES = ["G0", "G1", "G2", "G3", "G4"] as const;
export const GateSchema = z.enum(GATES);
export type Gate = z.infer<typeof GateSchema>;

/** 感情（MiniMax TTS）。 */
export const EMOTIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "fearful",
  "surprised",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** UIで選べる声の候補。女声=Seed Speech(minimi_ja＋pitch)/男声=Gemini TTSで統一。
 *  実体の振り分けは lib/tts.ts の VOICE_PRESETS。 */
export const VOICE_OPTIONS: { id: string; label: string }[] = [
  { id: "f_calm", label: "女声：標準" },
  { id: "f_high", label: "女声：高め" },
  { id: "f_low", label: "女声：低め・落ち着き" },
  { id: "f_bright", label: "女声：明るめ" },
  { id: "Puck", label: "男声：Puck（Gemini・若い系）" },
  { id: "Fenrir", label: "男声：Fenrir（Gemini・荒め）" },
  { id: "Charon", label: "男声：Charon（Gemini・落ち着き）" },
  { id: "Orus", label: "男声：Orus（Gemini・力強い）" },
];

/** 声の系統 → 既定の声ID（初回G3の自動割当用）。男声はGemini TTS。 */
export const DEFAULT_CATEGORY_VOICE: Record<string, string> = {
  adult_male: "Charon",
  young_male: "Puck",
  adult_female: "f_calm",
  young_female: "f_high",
  child: "Puck",
  narration: "f_calm",
  other: "f_calm",
};

/** トーン（話者ごとの基本の抑揚）。 */
export const TONES = ["calm", "normal", "lively"] as const;
export const TONE_LABELS: Record<string, string> = {
  calm: "落ち着き",
  normal: "標準",
  lively: "抑揚あり",
};

/** 年齢感（Gemini TTS の男声で有効。演技指示で声の年齢を変える）。 */
export const AGES = ["young", "standard", "mature"] as const;
export const AGE_LABELS: Record<string, string> = {
  young: "若い",
  standard: "標準",
  mature: "渋い",
};

/** 話者ごとの声設定（G3・ユーザーが承認画面で選べる）。感情はセリフ単位で自動付与。
 *  pitch=半音オフセット / tone=抑揚 / age=年齢感(Gemini男声で有効)。 */
export const VoiceCastEntrySchema = z.object({
  voice_id: z.string().default("f_calm"),
  speed: z.number().default(1.0),
  pitch: z.number().default(0),
  tone: z.string().default("normal"),
  age: z.string().default("standard"),
});
export type VoiceCastEntry = z.infer<typeof VoiceCastEntrySchema>;

/** UI/ログ表示用のゲート名称。 */
export const GATE_META: Record<Gate, { title: string; role: string }> = {
  G0: { title: "取り込み・解析", role: "ページを shot に分解し領域を把握" },
  G1: { title: "演出設計（コンテ）", role: "尺・カメラ・ビート・グレード生成 → 人が承認" },
  G2: { title: "素材分解", role: "レイヤー分離・吹き出し文字消し・背景inpaint" },
  G3: { title: "音声", role: "話者割当 → TTS生成 → セリフ実尺の計測" },
  G4: { title: "モーション・DEMO", role: "カメラ/背景モーション・文字順次出現・最小BGM → mp4" },
};

/* =====================================================================
 * 2. 共通サブスキーマ
 * ===================================================================== */

/**
 * 矩形領域 [x, y, w, h]（ページ内ピクセル座標）。
 * G0 がコマ位置・吹き出し位置の表現に使う。
 */
export const BBoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type BBox = z.infer<typeof BBoxSchema>;

/** カメラワーク（G1で計画 → G4でレンダリングパラメータとして使用）。 */
export const CameraSchema = z.object({
  type: CameraTypeSchema.default("static"),
  /** zoom率・パン方向・シェイク強度など。種別ごとに自由なキーを持つ。 */
  params: z.record(z.unknown()).default({}),
});
export type Camera = z.infer<typeof CameraSchema>;

/** 吹き出し文字の出現タイミング（秒）。G4でTTS実尺に同期して確定。 */
export const RevealTimingSchema = z.object({
  start: z.number(),
  end: z.number(),
});
export type RevealTiming = z.infer<typeof RevealTimingSchema>;

/** 吹き出し（1コマに複数ありうる）。 */
export const BubbleSchema = z.object({
  /** OCR抽出したセリフ本文（G0）。 */
  text: z.string().default(""),
  /** 吹き出しの種別（G0）。speech/thought/narration/sfx/other。 */
  kind: BubbleKindSchema.default("speech"),
  /**
   * G0で検出した吹き出しの位置。与件 §6 の例には未記載だが、
   * G4で「文字をどこに順次出現させるか」に必要なため補助フィールドとして持つ。
   */
  bbox: BBoxSchema.nullable().default(null),
  /** 話者割当（G3）。例: "male_a" / "female_a" / "narration"。 */
  speaker: z.string().nullable().default(null),
  /** セリフの感情（G3・TTSの自然さ用）。neutral/happy/sad/angry/fearful/surprised。空=未設定。 */
  emotion: z.string().default(""),
  /** 効果音(sfx)用の英語サウンド説明（G3が生成・空=未設定）。例: ぎゃあああ→"loud terrified scream"。 */
  sfx_prompt: z.string().default(""),
  /** 吹き出し文字を消し込んだクリーン画像のパス（G2）。 */
  erased_img: z.string().nullable().default(null),
  /**
   * G2が「実際に白塗りした範囲」（ページ絶対座標 [x,y,w,h]）。
   * 消し(吹き出し全体)と復元(reveal)の範囲を一致させるための正範囲。
   * これが無い(null)古いデータは G4 が bbox+余白でフォールバック。
   */
  erase_box: BBoxSchema.nullable().default(null),
  /** 文字の順次出現タイミング（G4・TTS実尺に同期）。 */
  reveal_timing: RevealTimingSchema.nullable().default(null),
});
export type Bubble = z.infer<typeof BubbleSchema>;

/**
 * バラした素材レイヤー（G2・動かすコマのみ）。
 * フィデリティロック: ここに入るのは「原画ピクセルの切り出し/背景inpaint」だけで、
 * キャラの線・顔をAIで作り直したものは入れない。
 */
export const LayersSchema = z.object({
  character: z.string().nullable().default(null),
  foreground: z.string().nullable().default(null),
  effect: z.string().nullable().default(null),
  background_inpainted: z.string().nullable().default(null),
});
export type Layers = z.infer<typeof LayersSchema>;

/** 合成音声クリップ（G3）。`dur` は生成後に計測した実尺。 */
export const VoiceClipSchema = z.object({
  clip: z.string(), // 音声ファイルのパス
  dur: z.number(), // 実尺(秒)。これが出てからG4で尺・文字出現を確定する。
  speaker: z.string().nullable().default(null),
  /** どの吹き出し(bubbles[index])のセリフかの対応。文字出現の同期に使う。 */
  bubble_index: z.number().int().nullable().default(null),
});
export type VoiceClip = z.infer<typeof VoiceClipSchema>;

/* =====================================================================
 * 3. shot（処理の最小単位）
 * ===================================================================== */

export const ShotSchema = z.object({
  /** "shot_01" のような識別子。 */
  id: z.string(),

  /* ---- G0: 取り込み・解析 ---- */
  bbox: BBoxSchema, // ページ内のコマ位置
  /** 多ページ（v3）：このコマが属するページid。""＝単一ページ（meta.pages[0] / source_image）。 */
  page_id: z.string().default(""),
  /** コマの簡単な説明（G0）。レビュー表示とG1の入力に使う。spec例には無い補助フィールド。 */
  description: z.string().default(""),

  /* ---- G1: 演出設計（人が承認） ---- */
  grade: GradeSchema.nullable().default(null),
  beat: BeatSchema.nullable().default(null),
  duration_sec: z.number().nullable().default(null), // G1で仮置き → G3実尺により補正
  camera: CameraSchema.default({}),
  /** コマの見せ方（G4）。auto/fit/fill/pan。 */
  framing: FramingSchema.default("auto"),
  /** 演出B：このコマの背景テーマ（""=meta.theme継承）。 */
  background: BackgroundSchema.default({}),
  /** 演出B：このコマの額装スタイル（全0/false=従来どおり）。 */
  panel_style: PanelStyleSchema.default({}),
  /** 演出C：このコマの登場トランジション（既定 cut=なし）。 */
  transition_in: TransitionSchema.default({}),

  /* ---- 吹き出し（G0で検出、以降のゲートが書き足す） ---- */
  bubbles: z.array(BubbleSchema).default([]),

  /* ---- G2: 素材分解（動かすコマのみ） ---- */
  layers: LayersSchema.default({}),

  /* ---- G3: 音声 ---- */
  voice: z.array(VoiceClipSchema).default([]),

  /** 口パク用。region=差し替える顔領域。closed_img/half_img/open_img=その顔を「口閉じ/半開き/口開き」に
   *  AI再描画した3枚。喋り中は音量レベル(levels)に応じて 閉→半→開 を切り替える＝音の大小で口の開きが変わる。
   *  常にいずれかを表示するので四角い継ぎ目は出ない。half_img が無い場合は閉/開の2枚で動く。
   *  levels=各 level_step 秒ごとの口の開き(0=閉/1=半/2=開、shot相対時間で先頭から並ぶ)。
   *  voiced=声が出ている区間[start,end]（shot相対秒・体の微動や後方互換のフォールバック用）。
   *  facing=front/side で口パク、away等は body動作。 */
  mouth: z
    .object({
      region: BBoxSchema,
      mouth_box: BBoxSchema.optional(),
      closed_img: z.string().nullable().default(null),
      half_img: z.string().nullable().default(null),
      open_img: z.string().nullable().default(null),
      facing: z.string().default("front"),
      voiced: z.array(z.array(z.number())).default([]),
      levels: z.array(z.number()).default([]),
      level_step: z.number().default(0.06),
      /** 人が承認画面で「このコマは口パクしない」にしたフラグ。true=静止（素材は保持＝再生成なしで即ON/OFF可）。
       *  画面外の人物のセリフを聞き手に誤検出した時などの手動補正用。 */
      disabled: z.boolean().default(false),
    })
    .nullable()
    .default(null),

  /* ---- 将来フェーズ用スロット（与件 §3.2 / データだけ先行確保） ---- */
  /** G6: 外注向け本制作指示スロット。 */
  motion_spec: z.record(z.unknown()).default({}),
  /** 効果音(SE)。G3で生成（cassetteai）。{clip,dur,bubble_index,prompt}。 */
  sfx: z
    .array(
      z.object({
        clip: z.string(),
        dur: z.number(),
        bubble_index: z.number().int().nullable().default(null),
        prompt: z.string().default(""),
      })
    )
    .default([]),
  /** G5: コマ別BGM切替スロット。MVPの最小BGMは meta.bgm_track 側。 */
  bgm_ref: z.string().nullable().default(null),
  /** 着色(G2.5)スロット。 */
  colorized: z.boolean().default(false),
});
export type Shot = z.infer<typeof ShotSchema>;

/* =====================================================================
 * 4. meta / outputs / cost_log
 * ===================================================================== */

/** ページ（多ページ対応・v3）。1ページ=1ソース画像。既存の単一ページは pages 空＝meta.source_image を使う。 */
export const PageSchema = z.object({
  id: z.string(), // "page_01" など
  source_image: z.string(), // storage 上のページ画像パス
  index: z.number().int().default(0), // 並び順
});
export type Page = z.infer<typeof PageSchema>;

export const MetaSchema = z.object({
  /* ---- 管理用（アプリが付与） ---- */
  project_id: z.string(),
  schema_version: z.number().int().default(SCHEMA_VERSION),
  title: z.string().default(""),
  created_at: z.string(), // ISO8601文字列

  /* ---- 入力（与件 §4.1） ---- */
  source_image: z.string(), // 統合画像のパス/参照（多ページ時は pages[0] と同じ＝後方互換）
  /** 多ページ（v3）。空＝単一ページ（source_image を使う）。複数ページの章はここに全ページを入れる。 */
  pages: z.array(PageSchema).default([]),
  delivery: DeliverySchema.default("vertical"),
  target_duration_sec: z.number().default(22),
  grade_policy: GradePolicySchema.default("auto"),

  /* ---- 演出レイヤー（デバイスB） ---- */
  /** プロジェクト既定の背景テーマ（presets.ts の BACKGROUND_THEMES のid）。per-shotで上書き可。
   *  既定 "letterbox_black" = 従来の黒帯。 */
  theme: z.string().default("letterbox_black"),
  /** 適用時の演出プリセットライブラリ版（再現性ピン）。0=演出レイヤー以前。G1が刻む。 */
  preset_library_version: z.number().int().default(0),

  /* ---- G4: 最小BGM一発（プリセットから1曲）。SE・複数BGMは将来。 ---- */
  bgm_track: z.string().nullable().default(null),
});
export type Meta = z.infer<typeof MetaSchema>;

export const OutputsSchema = z.object({
  demo_mp4: z.string().nullable().default(null), // 多ページ時は連結した章通し1本
  /** 多ページ（v3）：ページ単位のクリップ。{page_id, mp4}。個別納品＋連結の元。 */
  page_clips: z
    .array(z.object({ page_id: z.string(), mp4: z.string() }))
    .default([]),
  /** 将来(G6) 本制作用パッケージの出力先。 */
  package_path: z.string().nullable().default(null),
});
export type Outputs = z.infer<typeof OutputsSchema>;

/** ゲート別の処理時間・APIコスト記録（与件 §8 非機能要件：年間予算試算の原資）。 */
export const CostLogEntrySchema = z.object({
  gate: z.string(), // "G2" など
  elapsed_sec: z.number().default(0),
  api_cost: z.number().default(0), // USD想定
  note: z.string().default(""),
  at: z.string().nullable().default(null), // 記録時刻ISO
});
export type CostLogEntry = z.infer<typeof CostLogEntrySchema>;

/* =====================================================================
 * 5. pipeline（ゲート進捗・レビューゲート管理）※実装上の拡張
 * ---------------------------------------------------------------------
 * 与件 §8「再現性（任意ゲートからやり直せる）」「レビューゲート（G1に人の承認）」
 * を満たすための進捗トラッキング。与件のJSON例には無いが、途中保存・再開と
 * G1承認を実現するために追加している。
 * ===================================================================== */

export const GateStateEnum = z.enum(["pending", "running", "done", "error"]);
export type GateState = z.infer<typeof GateStateEnum>;

export const PipelineGateSchema = z.object({
  state: GateStateEnum.default("pending"),
  /** 人による承認。G1のレビューゲートで使用（true になるまでG2に進ませない）。 */
  approved: z.boolean().default(false),
  updated_at: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type PipelineGate = z.infer<typeof PipelineGateSchema>;

export const PipelineSchema = z.object({
  G0: PipelineGateSchema.default({}),
  G1: PipelineGateSchema.default({}),
  G2: PipelineGateSchema.default({}),
  G3: PipelineGateSchema.default({}),
  G4: PipelineGateSchema.default({}),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

/* ---------------------------------------------------------------------
 * 演出レイヤー（デバイスD/E）：タイトル/アイキャッチ/ナレーション文字カード。
 * コマとは別の「画面」としてタイムラインに差し込む（コマ尺はずらすが shots[] の index は不変）。
 * template の実体は lib/presets.ts の CARD_TEMPLATES。
 * ------------------------------------------------------------------- */
export const CARD_ROLES = ["title", "eyecatch", "narration"] as const;
export const CardRoleSchema = z.enum(CARD_ROLES);
export type CardRole = z.infer<typeof CardRoleSchema>;

export const CardSchema = z.object({
  id: z.string(),
  role: CardRoleSchema.default("title"),
  /** CARD_TEMPLATES のキー。 */
  template: z.string().default("title_default"),
  /** 配置：先頭に出す（at_start）／指定コマの後に出す（after_shot=shot id）。 */
  at_start: z.boolean().default(false),
  after_shot: z.string().nullable().default(null),
  dur_sec: z.number().default(2.5),
  /** 表示テキスト（1要素=1行/縦書きなら1列）。 */
  lines: z.array(z.string()).default([]),
  /** ロゴ画像（任意・将来）。 */
  logo_asset: z.string().nullable().default(null),
  /** ナレ読み上げ声（任意・既定は無音）。 */
  narration_voice: z.string().nullable().default(null),
});
export type Card = z.infer<typeof CardSchema>;

/* =====================================================================
 * 6. プロジェクト全体
 * ===================================================================== */

export const ProjectSchema = z.object({
  meta: MetaSchema,
  pipeline: PipelineSchema.default({}),
  shots: z.array(ShotSchema).default([]),
  /** 演出D/E：タイトル/アイキャッチ/ナレ文字カード。 */
  cards: z.array(CardSchema).default([]),
  /** 話者ID → 声設定（G3）。承認画面で編集可。 */
  voice_cast: z.record(VoiceCastEntrySchema).default({}),
  outputs: OutputsSchema.default({}),
  cost_log: z.array(CostLogEntrySchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

/* =====================================================================
 * 7. 暫定デフォルト（与件 §12「未確定・要確認」への仮置き）
 * ---------------------------------------------------------------------
 * いずれも合田さんが後で差し替える前提の暫定値。
 * ===================================================================== */

/** §12-1 グレード方針の初期値: 量産前提なので auto(自動仕分け) を既定に。 */
export const DEFAULT_GRADE_POLICY: GradePolicy = "auto";

/** 目標尺の既定（与件 §6 の例に合わせて22秒）。 */
export const DEFAULT_TARGET_DURATION_SEC = 22;

/** §12-3 BGMプリセット: まずは1曲固定で開始（プリセット追加は後から）。 */
export const DEFAULT_BGM_TRACK = "bgm_preset_tension_01.mp3";

/**
 * §12-2 TTS話者の当て方（暫定）: 話者ID → ElevenLabs声プリセットの対応表。
 * 値（voice_id）はダミー。G3着手時に実IDへ差し替える。
 * 検出キャラ数に応じて male_a/female_a... と機械的に割り当てる方針。
 */
export const DEFAULT_SPEAKER_VOICES: Record<string, string> = {
  male_a: "elevenlabs_voice_male_a_placeholder",
  female_a: "elevenlabs_voice_female_a_placeholder",
  narration: "elevenlabs_voice_narration_placeholder",
};

/* =====================================================================
 * 8. ファクトリ / ヘルパ
 * ===================================================================== */

/**
 * 空のプロジェクトJSONを生成する（G0着手前の初期状態）。
 * `created_at` は呼び出し側で `new Date().toISOString()` を渡す
 * （この関数自体は時刻を生成しないので純粋・テストしやすい）。
 */
export function createEmptyProject(input: {
  project_id: string;
  source_image: string;
  created_at: string;
  title?: string;
  delivery?: Delivery;
  target_duration_sec?: number;
  grade_policy?: GradePolicy;
  bgm_track?: string | null;
}): Project {
  return ProjectSchema.parse({
    meta: {
      project_id: input.project_id,
      schema_version: SCHEMA_VERSION,
      title: input.title ?? "",
      created_at: input.created_at,
      source_image: input.source_image,
      delivery: input.delivery ?? "vertical",
      target_duration_sec: input.target_duration_sec ?? DEFAULT_TARGET_DURATION_SEC,
      grade_policy: input.grade_policy ?? DEFAULT_GRADE_POLICY,
      bgm_track: input.bgm_track ?? DEFAULT_BGM_TRACK,
    },
    // shots / outputs / cost_log / pipeline はスキーマのデフォルトで埋まる
  });
}

/**
 * 任意のオブジェクトをProjectとして検証する（保存JSONの読み込み時など）。
 * 壊れたJSONを早期に弾くための入口。
 */
export function parseProject(data: unknown): Project {
  return ProjectSchema.parse(data);
}

/** 検証に失敗しても例外を投げない版（UIでのエラー表示用）。 */
export function safeParseProject(data: unknown) {
  return ProjectSchema.safeParse(data);
}
