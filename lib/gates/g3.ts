/**
 * G3 音声（話者割当 → TTS生成 → セリフ実尺の計測 ＋ 効果音生成）
 * ------------------------------------------------------------------
 * 仕様書の肝: G3はG4より前。セリフ実尺が出てからG4で尺・文字出現を確定する。
 *
 * 1) 初回: ページ画像を見て各セリフに話者・声の系統・感情を割当（Claude vision）。
 *    効果音(sfx)には英語のサウンド説明を割当。
 * 2) セリフ → MiniMax(日本語)でTTS。効果音 → cassetteaiで生成。
 * 3) 実尺を計測 → shot.voice[]/shot.sfx[]、コマ尺を実尺で下限補正。
 * 再実行時: 既に割当済みなら Claude を呼ばず、声/効果音を作り直すだけ（高速）。
 */
import { GATE_MODELS, visionJson } from "../anthropic";
import { loadSourceImage } from "../image";
import { getStorage } from "../storage";
import { synthSfx, synthVoice } from "../tts";
import { DEFAULT_CATEGORY_VOICE, type Project } from "../schema";

const VOICE_CATEGORIES = [
  "adult_male",
  "young_male",
  "adult_female",
  "young_female",
  "child",
  "narration",
  "other",
] as const;
const EMOTIONS = ["neutral", "happy", "sad", "angry", "fearful", "surprised"] as const;

// scream(叫び声)も「キャラ本人の発声」なので、seリフ等と同じくTTS対象（配役した声で読む）。
// sfx(擬音の書き文字。誰かの発声ではない)だけ専用の効果音生成に回す。
const SPEAK_KINDS = new Set(["speech", "thought", "narration", "scream"]);
const isSpeakable = (t: string) => /[ぁ-んァ-ヶ一-龥a-zA-Z0-9]/.test(t || "");

const ASSIGN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ref: { type: "string" },
          speaker_id: { type: "string" },
          voice_category: { type: "string", enum: [...VOICE_CATEGORIES] },
          emotion: { type: "string", enum: [...EMOTIONS] },
        },
        required: ["ref", "speaker_id", "voice_category", "emotion"],
      },
    },
    sfx: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ref: { type: "string" },
          sound_description: { type: "string" },
        },
        required: ["ref", "sound_description"],
      },
    },
  },
  required: ["assignments", "sfx"],
};

type Assignment = {
  ref: string;
  speaker_id: string;
  voice_category: string;
  emotion: string;
};
type SfxAssign = { ref: string; sound_description: string };
type Item = { ref: string; si: number; bi: number; text: string };

export async function gateG3(
  project: Project
): Promise<{ api_cost: number; note: string }> {
  if (!project.pipeline.G1.approved) {
    throw new Error("先にG1（コンテ）を承認してください（レビューゲート）");
  }

  const dialogue: Item[] = [];
  const sfxItems: Item[] = [];
  project.shots.forEach((s, si) => {
    s.bubbles.forEach((b, bi) => {
      if (!isSpeakable(b.text)) return;
      const it = { ref: `${s.id}:${bi}`, si, bi, text: b.text };
      if (SPEAK_KINDS.has(b.kind)) dialogue.push(it);
      else if (b.kind === "sfx") sfxItems.push(it);
    });
  });

  if (dialogue.length === 0 && sfxItems.length === 0) {
    project.shots.forEach((s) => {
      s.voice = [];
      s.sfx = [];
    });
    return { api_cost: 0, note: "発話・効果音なし" };
  }

  let cost = 0;
  let assigned = false;

  const dialogueReady = dialogue.every((it) => {
    const b = project.shots[it.si].bubbles[it.bi];
    return !!b.speaker && !!b.emotion;
  });
  const sfxReady = sfxItems.every((it) => !!project.shots[it.si].bubbles[it.bi].sfx_prompt);
  const castReady =
    dialogueReady && sfxReady && Object.keys(project.voice_cast).length > 0;

  if (!castReady) {
    const img = await loadSourceImage(project);
    const kindTag = (it: Item) => {
      const k = project.shots[it.si].bubbles[it.bi].kind;
      return k === "scream" ? "叫び声" : k === "thought" ? "心の声" : k === "narration" ? "ナレ" : "セリフ";
    };
    const dlist =
      dialogue.map((it) => `${it.ref}[${kindTag(it)}]: 「${it.text}」`).join("\n") || "（なし）";
    const slist = sfxItems.map((it) => `${it.ref}: 「${it.text}」`).join("\n") || "（なし）";
    const res = await visionJson({
      model: GATE_MODELS.G3,
      system: "あなたはマンガの音声演出担当です。指定スキーマに厳密に従います。",
      prompt: `添付はマンガ1ページ全体です。

【セリフ・叫び声】各refについて、絵と文脈から判断（[ ]内はセリフ/叫び声/心の声/ナレの種別）:
${dlist}
- speaker_id: 同じ登場人物は必ず同じID（male_a/female_a/boy_a/narration等）。一貫させる。叫び声[叫び声]も、その人物の普段のセリフと同じspeaker_idにする（声色は同じ人物のまま、感情だけ強くする）。
- voice_category: ${VOICE_CATEGORIES.join(" / ")} から1つ。**喋っている人物の見た目の性別・年齢に必ず合わせる**（男性キャラに女性系の声を割当てない）。ナレ枠は narration。
- emotion: ${EMOTIONS.join(" / ")} から1つ。[叫び声]は基本 angry / fearful / surprised のいずれか強めのものを選ぶ（絶叫の迫力を声の感情表現で出す）。説教は angry、淡々としたセリフは neutral 等。

【効果音(sfx)】各refの擬音（＝誰かの発声ではない環境音・衝撃音の書き文字）を、生成用の短い英語サウンド説明にする:
${slist}
- sound_description: 英語で具体的に（例: だっだっだっ→"fast running footsteps on pavement"、ドン→"heavy impact thud"、ゴゴゴ→"ominous low rumble"）。`,
      image: { data: img.data, mediaType: img.mediaType },
      jsonSchema: ASSIGN_SCHEMA,
    });
    cost += res.costUsd;
    assigned = true;
    const data = res.data as { assignments?: Assignment[]; sfx?: SfxAssign[] };
    const amap = new Map((data.assignments ?? []).map((a) => [a.ref, a]));
    const smap = new Map((data.sfx ?? []).map((a) => [a.ref, a]));
    // 既にセリフ割当済みなら上書きしない（手で直した話者を守る）
    if (!dialogueReady) {
      for (const it of dialogue) {
        const a = amap.get(it.ref);
        const sid = a?.speaker_id || "speaker_a";
        const b = project.shots[it.si].bubbles[it.bi];
        b.speaker = sid;
        b.emotion = a?.emotion || "neutral";
        if (!project.voice_cast[sid]) {
          project.voice_cast[sid] = {
            voice_id: DEFAULT_CATEGORY_VOICE[a?.voice_category || "other"] || "f_calm",
            speed: 1.0,
            pitch: 0,
            tone: "normal",
            age: "standard",
          };
        }
      }
    }
    if (!sfxReady) {
      for (const it of sfxItems) {
        const a = smap.get(it.ref);
        project.shots[it.si].bubbles[it.bi].sfx_prompt =
          a?.sound_description || "short cartoon sound effect";
      }
    }
  }

  const storage = getStorage();

  // セリフTTS（並列）
  const voiceResults = await Promise.all(
    dialogue.map(async (it) => {
      const b = project.shots[it.si].bubbles[it.bi];
      const sid = b.speaker || "speaker_a";
      const cast =
        project.voice_cast[sid] ??
        { voice_id: "f_calm", speed: 1.0, pitch: 0, tone: "normal", age: "standard" };
      const { bytes, durationSec } = await synthVoice(it.text, {
        voice_id: cast.voice_id,
        speed: cast.speed,
        emotion: b.emotion || "neutral",
        pitch: cast.pitch,
        tone: cast.tone,
        age: cast.age,
      });
      const rel = `voice/${it.ref.replace(":", "_b")}.mp3`;
      await storage.putAsset(project.meta.project_id, rel, bytes, "audio/mpeg");
      return { ...it, sid, rel, dur: durationSec };
    })
  );

  // 効果音生成（並列）
  const sfxResults = await Promise.all(
    sfxItems.map(async (it) => {
      const prompt = project.shots[it.si].bubbles[it.bi].sfx_prompt || "sound effect";
      const { bytes, durationSec } = await synthSfx(prompt, 3);
      const rel = `sfx/${it.ref.replace(":", "_b")}.mp3`;
      await storage.putAsset(project.meta.project_id, rel, bytes, "audio/mpeg");
      return { ...it, rel, dur: durationSec, prompt };
    })
  );

  project.shots.forEach((s) => {
    s.voice = [];
    s.sfx = [];
  });
  for (const r of voiceResults) {
    project.shots[r.si].voice.push({
      clip: r.rel,
      dur: r.dur,
      speaker: r.sid,
      bubble_index: r.bi,
    });
  }
  for (const r of sfxResults) {
    project.shots[r.si].sfx.push({
      clip: r.rel,
      dur: r.dur,
      bubble_index: r.bi,
      prompt: r.prompt,
    });
  }

  // 尺の実尺補正（セリフ実尺の合計＋間）。上下両方向に合わせる＝G1の見積もりが長すぎた時の
  // 「セリフ後の無音の間」も解消する。ただし人が尺を打ち替えていた（前回の自動値と差がある）場合は
  // 演出意図とみなして触らない。空欄に戻す（null）と再び自動に戻る。
  for (const s of project.shots) {
    const total = s.voice.reduce((t, v) => t + v.dur, 0);
    if (total > 0) {
      const need = Math.round((total + 0.6 * s.voice.length + 0.4) * 10) / 10;
      const manual =
        s.duration_auto_sec != null &&
        s.duration_sec != null &&
        Math.abs(s.duration_sec - s.duration_auto_sec) > 0.01;
      if (!manual) s.duration_sec = need;
      s.duration_auto_sec = need;
    }
  }

  const chars = dialogue.reduce((n, it) => n + it.text.length, 0);
  const ttsCost = Math.round((chars / 1000) * 0.1 * 1e4) / 1e4; // MiniMax $0.10/1000字
  const sfxSec = sfxResults.reduce((t, r) => t + r.dur, 0);
  const sfxCost = Math.round(sfxSec * 0.002 * 1e4) / 1e4; // ElevenLabs SFX V2 $0.002/秒
  const totalDur = voiceResults.reduce((t, r) => t + r.dur, 0);
  return {
    api_cost: Math.round((cost + ttsCost + sfxCost) * 1e6) / 1e6,
    note: `TTS ${voiceResults.length}＋効果音 ${sfxResults.length}（声=話者別エンジン/効果音=ElevenLabs SFX V2）/ ${assigned ? "自動割当" : "再生成"} / 実尺≈${totalDur.toFixed(1)}s（概算）`,
  };
}
