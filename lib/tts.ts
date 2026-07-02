/**
 * TTS（fal.ai 経由 ByteDance Seed Speech v2・日本語ネイティブ）
 * テキスト＋声設定 → mp3バイト ＋ 実尺(秒)。
 * voice_id はUIの選択肢(SEED_PRESETS)で、実体は minimi_ja＋pitch＋演技指示(voice_instruction)。
 * 実尺は応答に無いため mp3 を解析して計測する。
 */
import { parseBuffer } from "music-metadata";
import { falRun, fetchImageBytes } from "./fal";
import { applySpeedPitch } from "./audiofx";

export const TTS_MODEL = "fal-ai/bytedance/seed-speech/tts/v2"; // 女声（Seed Speech）
export const ELEVEN_TTS_MODEL = "fal-ai/elevenlabs/tts/eleven-v3"; // 男声（ElevenLabs 既存ボイス）
export const MINIMAX_MODEL = "fal-ai/minimax/speech-02-hd"; // 男声（MiniMax・speed/pitch/emotion対応）
export const GEMINI_TTS_MODEL = "fal-ai/gemini-tts"; // 男声（Gemini TTS・演技指示で年齢/感情）
// 効果音は ElevenLabs Sound Effects V2（人の悲鳴〜衝撃音まで高品質。合田さん承認 2026-06-26）。
export const SFX_MODEL = "fal-ai/elevenlabs/sound-effects/v2";
export const KOKORO_MODEL = "fal-ai/kokoro/japanese";

/** Kokoro（日本語ネイティブTTS）。voice=jf_alpha 等。emotion指定は無い。 */
export async function synthKokoro(
  text: string,
  voice: string,
  speed = 1.0
): Promise<{ bytes: Buffer; durationSec: number }> {
  const out = await falRun(KOKORO_MODEL, { prompt: text, voice, speed });
  const a = (out.audio ?? out.audio_url) as { url?: string } | string | undefined;
  const url = typeof a === "string" ? a : a?.url;
  if (!url) throw new Error("Kokoro結果に音声URLがありません: " + JSON.stringify(out).slice(0, 200));
  const bytes = await fetchImageBytes(url);
  let durationSec = 0;
  try {
    const meta = await parseBuffer(new Uint8Array(bytes), { mimeType: "audio/mpeg" });
    durationSec = meta.format.duration ?? 0;
  } catch {
    /* ignore */
  }
  if (!durationSec) durationSec = (bytes.length * 8) / 128000;
  return { bytes, durationSec: Math.round(durationSec * 100) / 100 };
}

/** 効果音生成（英語プロンプト＋長さ → mp3）。擬音(ぎゃあああ/だっだっ等)用。
 *  ElevenLabs SFX V2: text=英語の音の説明 / duration_seconds=長さ / prompt_influence=指示への忠実度。 */
export async function synthSfx(
  prompt: string,
  durationSec: number
): Promise<{ bytes: Buffer; durationSec: number }> {
  const dur = Math.max(0.5, Math.min(durationSec, 12));
  const out = await falRun(SFX_MODEL, {
    text: prompt,
    duration_seconds: Math.round(dur * 10) / 10,
    prompt_influence: 0.5,
  });
  const a = (out.audio ?? out.audio_file ?? out.audio_url) as { url?: string } | string | undefined;
  const url = typeof a === "string" ? a : a?.url;
  if (!url) throw new Error("効果音結果に音声URLがありません: " + JSON.stringify(out).slice(0, 200));
  const bytes = await fetchImageBytes(url);
  let measured = 0;
  try {
    const meta = await parseBuffer(new Uint8Array(bytes), { mimeType: "audio/mpeg" });
    measured = meta.format.duration ?? 0;
  } catch {
    /* ignore */
  }
  return { bytes, durationSec: measured || dur };
}

/** UIの声プリセット → 実エンジン/パラメータ。
 *  女声(f_*) = Seed Speech(minimi_ja＋pitch)。男声 = ElevenLabs の既存ボイス。
 *  m_系・narration は旧Seed疑似男声（UIには出さないがフォールバックで解決可能）。 */
type SeedPreset = { engine: "seed"; voice: string; pitch: number; prefix: string };
type ElevenPreset = { engine: "eleven"; voice: string };
type MinimaxPreset = { engine: "minimax"; voice: string };
type GeminiPreset = { engine: "gemini"; voice: string };
export const VOICE_PRESETS: Record<
  string,
  SeedPreset | ElevenPreset | MinimaxPreset | GeminiPreset
> = {
  // 女声（Seed Speech）
  f_calm: { engine: "seed", voice: "minimi_ja", pitch: 0, prefix: "" },
  f_high: { engine: "seed", voice: "minimi_ja", pitch: 2, prefix: "" },
  f_low: { engine: "seed", voice: "minimi_ja", pitch: -2, prefix: "落ち着いた大人の女性の声で" },
  f_bright: { engine: "seed", voice: "minimi_ja", pitch: 1, prefix: "明るく元気な声で" },
  // 旧Seed疑似男声（フォールバック用）
  m_mid: { engine: "seed", voice: "minimi_ja", pitch: -3, prefix: "落ち着いた男性の声で" },
  m_deep: { engine: "seed", voice: "minimi_ja", pitch: -6, prefix: "低く力強い男性の声で" },
  narration: { engine: "seed", voice: "minimi_ja", pitch: -1, prefix: "ナレーションのように" },
  // 男声（Gemini TTS・演技指示で年齢/感情）。UIで選べる男声はこの4つに統一。
  Puck: { engine: "gemini", voice: "Puck" },
  Fenrir: { engine: "gemini", voice: "Fenrir" },
  Charon: { engine: "gemini", voice: "Charon" },
  Orus: { engine: "gemini", voice: "Orus" },
  // 男声（MiniMax・旧候補。UIからは撤去。既存プロジェクトの参照解決用に残す）
  mm_patient: { engine: "minimax", voice: "Patient_Man" },
  mm_deep: { engine: "minimax", voice: "Deep_Voice_Man" },
  mm_boy: { engine: "minimax", voice: "Decent_Boy" },
  // 男声（ElevenLabs・旧候補。フォールバック用に解決可能）
  Liam: { engine: "eleven", voice: "Liam" },
  Eric: { engine: "eleven", voice: "Eric" },
  River: { engine: "eleven", voice: "River" },
};

/** 感情 → 日本語の演技指示（Seedのvoice_instructionに渡す）。 */
const EMOTION_INSTR: Record<string, string> = {
  neutral: "自然で落ち着いた口調で",
  happy: "明るく嬉しそうに",
  sad: "悲しげに、沈んだ声で",
  angry: "強い怒りで激しく言い放つように",
  fearful: "怯えた様子で、不安げに",
  surprised: "驚いた様子で",
};

/** 感情 → ElevenLabs の stability（低いほど抑揚が大きい＝感情が強く出る）。 */
const EMOTION_STABILITY: Record<string, number> = {
  neutral: 0.5,
  happy: 0.4,
  sad: 0.45,
  angry: 0.25,
  fearful: 0.3,
  surprised: 0.3,
};

/** トーン（話者ごとの基本の抑揚）。emotionが neutral のときの既定。 */
const TONE_STABILITY: Record<string, number> = {
  calm: 0.65, // 落ち着き（抑揚控えめ）
  normal: 0.45,
  lively: 0.25, // 抑揚あり（生き生き）
};
const TONE_INSTR_SEED: Record<string, string> = {
  calm: "落ち着いた口調で",
  normal: "",
  lively: "抑揚をつけて生き生きと",
};

/** 年齢感 → Gemini TTS の演技指示。 */
const AGE_STYLE_GEMINI: Record<string, string> = {
  young: "20代前半の若々しい男性の声で",
  standard: "30代くらいの大人の男性の声で",
  mature: "年配の渋い男性の声で",
};
/** 感情 → Gemini TTS の演技指示（日本語）。 */
const GEMINI_EMOTION: Record<string, string> = {
  happy: "明るく嬉しそうに",
  sad: "悲しげに",
  angry: "怒気を込めて強く言い放つように",
  fearful: "怯えた様子で",
  surprised: "驚いた様子で",
};

export type VoiceSpec = {
  voice_id: string;
  speed?: number;
  emotion?: string;
  pitch?: number; // 半音オフセット（-で低く/+で高く）。Seedは生成時/ElevenLabs・Geminiは後処理で適用。
  tone?: string; // calm | normal | lively（話者ごとの基本トーン）
  age?: string; // young | standard | mature（Gemini男声の年齢感）
};

export async function synthVoice(
  text: string,
  spec: VoiceSpec
): Promise<{ bytes: Buffer; durationSec: number }> {
  const preset = VOICE_PRESETS[spec.voice_id] ?? VOICE_PRESETS.f_calm;
  const tone = spec.tone || "normal";
  const emo = spec.emotion || "neutral";
  let out: Record<string, unknown>;
  let postFx = false;
  if (preset.engine === "eleven") {
    postFx = true;
    // 男声：ElevenLabs v3。感情(非neutral)優先、無ければトーンで stability を決める。
    const stability =
      emo !== "neutral"
        ? EMOTION_STABILITY[emo] ?? 0.45
        : TONE_STABILITY[tone] ?? 0.45;
    out = await falRun(ELEVEN_TTS_MODEL, { text, voice: preset.voice, stability });
  } else if (preset.engine === "minimax") {
    // 男声：MiniMax。speed/pitch/emotion をネイティブ対応（後処理なし）。
    out = await falRun(MINIMAX_MODEL, {
      text,
      voice_setting: {
        voice_id: preset.voice,
        speed: spec.speed ?? 1.0,
        pitch: spec.pitch ?? 0,
        emotion: emo,
      },
      language_boost: "Japanese",
      audio_setting: { format: "mp3" },
    });
  } else if (preset.engine === "gemini") {
    // 男声：Gemini TTS。年齢・抑揚・感情を演技指示(style_instructions)で。speed/pitchは後処理。
    postFx = true; // = 後処理フラグ流用
    const style =
      [
        AGE_STYLE_GEMINI[spec.age || "standard"] ?? "",
        TONE_INSTR_SEED[tone],
        emo !== "neutral" ? GEMINI_EMOTION[emo] ?? "" : "",
      ]
        .filter(Boolean)
        .join("、") || "自然な口調で";
    out = await falRun(GEMINI_TTS_MODEL, {
      prompt: text,
      style_instructions: style,
      voice: preset.voice,
      model: "gemini-2.5-pro-tts",
      output_format: "mp3",
    });
  } else {
    // 女声：Seed Speech。pitch/speedは生成時に適用＋トーン/感情を演技指示に。
    const instruction =
      [preset.prefix, TONE_INSTR_SEED[tone], emo !== "neutral" ? EMOTION_INSTR[emo] : ""]
        .filter(Boolean)
        .join("、") || "自然で落ち着いた口調で";
    out = await falRun(TTS_MODEL, {
      text,
      voice: preset.voice,
      speed: spec.speed ?? 1.0,
      pitch: preset.pitch + (spec.pitch ?? 0),
      voice_instruction: instruction,
      output_format: "mp3",
    });
  }

  const audio = out.audio as { url?: string } | undefined;
  const url = audio?.url ?? (out.audio_url as { url?: string } | undefined)?.url;
  if (!url) {
    throw new Error("TTS結果に音声URLがありません: " + JSON.stringify(out).slice(0, 200));
  }
  let bytes = await fetchImageBytes(url);
  // ElevenLabsは速さ/ピッチを持たないので、後処理で効かせる。
  if (postFx) bytes = applySpeedPitch(bytes, spec.speed ?? 1, spec.pitch ?? 0);

  let durationSec = 0;
  try {
    const meta = await parseBuffer(new Uint8Array(bytes), { mimeType: "audio/mpeg" });
    durationSec = meta.format.duration ?? 0;
  } catch {
    /* fall through */
  }
  if (!durationSec) durationSec = (bytes.length * 8) / 128000;
  return { bytes, durationSec: Math.round(durationSec * 100) / 100 };
}
