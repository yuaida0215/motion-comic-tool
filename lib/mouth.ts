/**
 * 口パク用の素材作り（server専用）。
 *  1) detectMouths: 「セリフを言っている人物」を内容・感情から特定し、その顔領域＋口だけのタイト枠＋向き(facing)を返す。
 *  2) generateOpenMouth: 顔領域の口だけを FLUX Fill マスクインペイントで「閉じ/半開き/開き」の3段階に塗り替え、
 *     差分（＝口の変化）だけを原画に重ねて closed/half/open の3枚を保存（マスク外は原画1px不変）。
 * 合成側は音量エンベロープ(levels: 0=閉/1=半/2=開)に応じて3枚を切り替える＝音の大小で口の開きが変わる。
 * 横顔は向き(facing=side)に応じてプロンプトとマスクを下方向に広げ、プロフィールの口開きに対応する。
 */
import sharp from "sharp";
import { fal } from "@fal-ai/client";
import { GATE_MODELS, visionJson } from "./anthropic";
import { loadPageImage, type LoadedImage } from "./image";
import { getStorage } from "./storage";
import type { Project } from "./schema";

// scream(叫び声)もキャラ本人が発する言葉＝口パク対象。sfx(擬音の書き文字)だけ対象外。
const SPEAK = new Set(["speech", "thought", "narration", "scream"]);
const hasJa = (t: string) => /[ぁ-んァ-ヶ一-龥a-zA-Z0-9]/.test(t || "");
const speakLines = (s: Project["shots"][number]) =>
  s.bubbles.filter((b) => SPEAK.has(b.kind) && hasJa(b.text));

// 段階1：コマから話者の顔と向き
const FACE1_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    speaker_in_panel: {
      type: "boolean",
      description:
        "このセリフを言っている人物がこのコマに描かれていて口も見えるなら true。話者が画面外で映っているのは聞き手（反応している人）なら false。",
    },
    facing: { type: "string", enum: ["front", "side", "away", "unclear"] },
    face_region: {
      type: "array",
      items: { type: "number" },
      description: "[x,y,w,h] 話者の顔まわり(目〜口を含む)を囲む。吹き出しは含めない。speaker_in_panel=false なら [0,0,0,0]。",
    },
  },
  required: ["speaker_in_panel", "facing", "face_region"],
};
// 段階2：拡大した顔から口だけを精密に
const MOUTH2_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean", description: "唇/口がこの画像に見えれば true、見えない(後頭部等)なら false" },
    mouth_box: {
      type: "array",
      items: { type: "number" },
      description: "[x,y,w,h] 唇と口が開く部分だけをタイトに。横顔は顔の前端(唇が出っ張る所)に置く。頬や顔の中央に置かない。",
    },
  },
  required: ["found", "mouth_box"],
};

/** 「セリフを言っている人物」を特定（段階1）→ 顔を拡大して口を精密検出（段階2）。口が見えなければ null。 */
export async function detectMouths(
  project: Project
): Promise<{ api_cost: number; detected: number }> {
  // 多ページ：コマごとに「そのページ」の画像（＋寸法）でクランプ／切り出す（キャッシュ）。
  const pageCache = new Map<string, LoadedImage>();
  const getPage = async (pid: string) => {
    if (!pageCache.has(pid)) pageCache.set(pid, await loadPageImage(project, pid));
    return pageCache.get(pid)!;
  };
  let cost = 0;
  let detected = 0;
  for (const s of project.shots) {
    const lines = speakLines(s);
    if (lines.length === 0) { s.mouth = null; continue; }
    const img = await getPage(s.page_id);
    const PW = img.width || 100000;
    const PH = img.height || 100000;
    const [x, y, w, h] = s.bbox;
    const crop = await sharp(img.bytes).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
    const lineList = lines.map((b) => `「${b.text}」(${b.emotion || "neutral"})`).join(" / ");

    // 段階1：顔と向き
    const r1 = await visionJson({
      model: GATE_MODELS.G0,
      system: "マンガのコマから『セリフを言っている人物』を特定し、その顔の位置と向きを正確に返します。話者が画面外なら正直に false を返します。",
      prompt: `このコマ(${w}x${h}px)に、次のセリフが添えられています：\n${lineList}\n\nまず **このセリフを言っている人物がこのコマに描かれていて口も見えるか** を判定してください。\n- 吹き出しの「しっぽ」が画面内の人物を指している／その人物の口の動きと一致するなら speaker_in_panel=true。\n- セリフが**画面外の別人**のもので、映っているのは**聞き手（反応しているだけ）**なら speaker_in_panel=false（この場合 face_region=[0,0,0,0]）。聞き手の口を勝手に動かさないこと。\n- speaker_in_panel=true のとき：複数人物がいれば**このセリフ（口調・感情）を言っている人物**を選ぶ（例：怒鳴るセリフなら口を開けて叫ぶ人物）。\n- facing: 正面=front / 横顔=side / 後ろ向き等で口が見えない=away。\n- face_region: [x,y,w,h] その人物の顔まわり（目〜口を含む。吹き出しは含めない）。\n座標はこのコマ画像内のピクセル。`,
      image: { data: crop.toString("base64"), mediaType: "image/png" },
      jsonSchema: FACE1_SCHEMA,
    });
    cost += r1.costUsd;
    const d1 = r1.data as { speaker_in_panel?: boolean; facing?: string; face_region?: number[] };
    const facing = d1.facing || "unclear";
    const fr = d1.face_region || [];
    // 話者が画面内に見えない（＝映っているのは聞き手）なら口パクしない
    if (d1.speaker_in_panel === false || !(facing === "front" || facing === "side") || fr.length !== 4 || fr[2] <= 0 || fr[3] <= 0) {
      s.mouth = null;
      continue;
    }
    // 顔領域(page座標)。検出の取りこぼし対策に少し余白を足す。
    const padX = fr[2] * 0.12, padY = fr[3] * 0.12;
    const frX = Math.max(0, Math.round(x + fr[0] - padX));
    const frY = Math.max(0, Math.round(y + fr[1] - padY));
    const frW = Math.max(8, Math.min(Math.round(fr[2] + padX * 2), PW - frX));
    const frH = Math.max(8, Math.min(Math.round(fr[3] + padY * 2), PH - frY));

    // 段階2：顔を拡大(幅 ZW)して口だけを精密検出
    const ZW = 460;
    const faceCrop = await sharp(img.bytes).extract({ left: frX, top: frY, width: frW, height: frH }).resize({ width: ZW }).png().toBuffer();
    const fcH = Math.max(1, Math.round((frH * ZW) / frW));
    const r2 = await visionJson({
      model: GATE_MODELS.G0,
      system: "拡大した顔の画像から、口（唇・開いた口）の位置だけを正確に返します。",
      prompt: `これはある人物の顔を拡大した画像(${ZW}x${fcH}px、向き=${facing === "side" ? "横顔" : "正面"})です。この人物はセリフ「${lineList}」を言っています。\n口（唇／開いた口）を**タイトに**囲んでください。\n- 横顔の場合、口は顔の輪郭の**前端（唇が突き出ている側）**にあります。頬や顔の中央に置かないこと。\n- 口が見えない（後頭部等）なら found=false。\n座標はこの拡大画像内のピクセル。`,
      image: { data: faceCrop.toString("base64"), mediaType: "image/png" },
      jsonSchema: MOUTH2_SCHEMA,
    });
    cost += r2.costUsd;
    const d2 = r2.data as { found?: boolean; mouth_box?: number[] };
    const mb2 = d2.mouth_box || [];

    // 口box(段階2のZW座標)→ page座標へ写像
    let mouthPage: [number, number, number, number];
    if (d2.found && mb2.length === 4 && mb2[2] > 0 && mb2[3] > 0) {
      const sx = frW / ZW, sy = frH / fcH;
      const mx = frX + mb2[0] * sx, my = frY + mb2[1] * sy;
      const mw = mb2[2] * sx, mh = mb2[3] * sy;
      mouthPage = [
        Math.max(frX, Math.round(mx)),
        Math.max(frY, Math.round(my)),
        Math.max(4, Math.round(mw)),
        Math.max(4, Math.round(mh)),
      ];
    } else {
      // フォールバック：顔下部中央を推定（正面向き想定）
      mouthPage = [Math.round(frX + frW * 0.32), Math.round(frY + frH * 0.6), Math.round(frW * 0.36), Math.round(frH * 0.22)];
    }

    s.mouth = {
      region: [frX, frY, frW, frH],
      mouth_box: mouthPage,
      closed_img: null,
      half_img: null,
      open_img: null,
      facing,
      voiced: [],
      levels: [],
      level_step: 0.06,
      disabled: false,
    };
    detected++;
  }
  return { api_cost: Math.round(cost * 1e6) / 1e6, detected };
}

/**
 * 口パク素材生成（マスク・インペイント方式）。
 *  原画の顔領域を高解像度化 → 口の位置に楕円マスク → FLUX Fill で「口だけ」を閉じ/開きに塗り替え
 *  → マスク外は原画のまま合成（顎・目・輪郭は1pxも動かない）。
 *  best-of-N 生成し、Claude画像認識で「異物の幻覚・顎崩れ・笑い・口の開閉」を採点して最良を採用。
 *  ※AIフルリドロー(GPT)は顔ごと描き直して別人になるため不可。インペイントが要。
 */
// string 型にして fal client の緩いオーバーロードを使う（client型は guidance_scale 等が未定義だがAPIは受理）
const FILL_MODEL: string = "fal-ai/flux-pro/v1/fill";
const S = 512; // インペイント解像度
const N_CANDIDATES = 4; // best-of-N（崩れ候補を採点で弾く確度を上げる。閉/半/開×N＝3N呼び出し/コマ）

/** コマの代表感情（吹き出しの emotion から）。 */
function dominantEmotion(s: Project["shots"][number]): string {
  const ems = speakLines(s).map((b) => (b.emotion || "neutral").toLowerCase());
  const counts: Record<string, number> = {};
  for (const e of ems) counts[e] = (counts[e] || 0) + 1;
  let best = ems[0] || "neutral";
  let bn = -1;
  for (const [e, n] of Object.entries(counts)) {
    if (e === "neutral") continue;
    if (n > bn) { best = e; bn = n; }
  }
  return best;
}

const STYLE =
  "black and white manga line art, clean confident ink lines that exactly match the original drawing style and line weight, no color, no gray smudges, no blur";
type MouthMode = "closed" | "half" | "open";
function mouthPrompt(mode: MouthMode, emo: string, facing: string): string {
  const angry = /(angry|rage|怒|shout|叫)/i.test(emo);
  const happy = /(happy|joy|smile|嬉|笑)/i.test(emo);
  const sad = /(sad|cry|悲|泣)/i.test(emo);
  const surprised = /(surprise|shock|驚)/i.test(emo);
  const tone = angry ? "tense serious angry expression, NOT smiling"
    : happy ? "natural expression"
    : sad ? "subdued expression, NOT smiling"
    : surprised ? "surprised expression, NOT smiling"
    : "calm neutral expression, NOT smiling";
  // 横顔は「プロフィール（横向き）」であることと、口の開き方（前方／下方へ）を明示する。
  const side = /^side/i.test(facing);
  const view = side
    ? "Profile view (head seen from the side). Keep the nose, eye and the outline of the face exactly as in the original; only change the lips/mouth."
    : "Front view. Keep the eyes, nose and the outline of the face exactly as in the original; only change the lips/mouth.";
  const openDesc = side
    ? "the lips parted in profile in a natural mid-speech position, the lower lip dropped only a little so a small clean mouth opening shows toward the front (NOT a wide shout, a simple clean open mouth, no messy or extra teeth)"
    : "the mouth open in a natural mid-speech position, lips parted with a small to moderate opening as if mid-word, a simple clean open mouth (NOT a wide shout, no messy or extra teeth)";
  const halfDesc = side
    ? "the mouth only SLIGHTLY open in profile, lips just parted a little (mid-syllable), a small gap between the lips"
    : "the mouth only SLIGHTLY open, lips just parted a little as between syllables, a small mouth opening (not wide)";
  const closedDesc = side
    ? "the lips gently CLOSED together in profile"
    : "the MOUTH FULLY CLOSED, lips gently together";
  const body =
    mode === "closed" ? `${closedDesc}. Do not add teeth or an open mouth.`
    : mode === "half" ? `${halfDesc}.`
    : `${openDesc}.`;
  return `${STYLE}. ${view} The same character with ${body} ${tone}.`;
}

/** FLUX Fill：白マスク部分だけを prompt で塗り替え（他は不変）。結果バイトを返す。 */
async function fluxFill(imageUrl: string, maskUrl: string, prompt: string): Promise<Buffer> {
  const r = await fal.subscribe(FILL_MODEL, {
    input: { prompt, image_url: imageUrl, mask_url: maskUrl, guidance_scale: 18, safety_tolerance: "6" },
  });
  const d = r.data as { images?: { url?: string }[]; image?: { url?: string } };
  const u = d.images?.[0]?.url || d.image?.url;
  if (!u) throw new Error("インペイント失敗（画像なし）");
  return Buffer.from(await (await fetch(u)).arrayBuffer());
}

/**
 * 人間の手順と同じ：下地＝原画の実寸(rw×rh)そのまま。「開き」は、インペイント結果が原画と"違う所だけ"
 * （＝口が開いた差分）を重ねる。顎・頬・唇まわりなど変化が無い所は原画のまま＝口以外は1pxも動かない。
 * ellipseRaw: 口周辺に限定する楕円(1ch,白=対象)。これで口以外の微差を無視する。
 */
async function compositeOpenDelta(
  origRegionRaw: Buffer, resPng: Buffer, ellipseRaw: Buffer, rw: number, rh: number
): Promise<{ buf: Buffer; deltaPx: number }> {
  const n = rw * rh;
  // FLUX結果は眠い(柔らかい)ので、原画のパキッとした線画に寄せるためシャープ化してから合成する。
  // これをしないと差し替えた口元だけ「絵が溶けて見える」＝顔が消えたように見える。
  const res = await sharp(resPng)
    .resize(rw, rh, { fit: "fill", kernel: "lanczos3" })
    .sharpen({ sigma: 1.2 })
    .removeAlpha()
    .raw()
    .toBuffer();
  if (origRegionRaw.length !== n * 3 || res.length !== n * 3 || ellipseRaw.length !== n) {
    throw new Error(`バッファサイズ不整合 orig=${origRegionRaw.length} res=${res.length} ell=${ellipseRaw.length} (n=${n})`);
  }
  const og = await sharp(origRegionRaw, { raw: { width: rw, height: rh, channels: 3 } }).greyscale().raw().toBuffer();
  const rg = await sharp(res, { raw: { width: rw, height: rh, channels: 3 } }).greyscale().raw().toBuffer();
  const THR = 26;
  const bin = Buffer.alloc(n, 0);
  let deltaPx = 0;
  for (let i = 0; i < n; i++) if (ellipseRaw[i] > 10 && Math.abs(og[i] - rg[i]) > THR) { bin[i] = 255; deltaPx++; }
  // 差分マスクを羽化（境目を自然に）。広いと口の周りが大きくにじむ＝顔が溶けるので、控えめに。
  const feather = Math.max(2, Math.round(Math.min(rw, rh) * 0.02));
  const alpha = await sharp(bin, { raw: { width: rw, height: rh, channels: 1 } }).blur(feather).raw().toBuffer();
  const ach = Math.max(1, Math.round(alpha.length / n)); // sharpが3chで返す場合を吸収
  const out = Buffer.from(origRegionRaw);
  for (let i = 0; i < n; i++) {
    const a = alpha[i * ach] / 255;
    if (a <= 0) continue;
    const di = i * 3;
    for (let c = 0; c < 3; c++) out[di + c] = Math.round(origRegionRaw[di + c] * (1 - a) + res[di + c] * a);
  }
  return { buf: await sharp(out, { raw: { width: rw, height: rh, channels: 3 } }).png().toBuffer(), deltaPx };
}

const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    hallucination: { type: "boolean", description: "元に無い別の絵/小さな顔/コマ枠/文字など異物が紛れ込んでいれば true" },
    mouth_state: { type: "string", enum: ["closed", "open", "partial"], description: "右の口の状態" },
    jaw_natural: { type: "boolean", description: "顎・輪郭が元と自然につながっていれば true、ズレ/崩れなら false" },
    smiling: { type: "boolean", description: "笑った口なら true" },
    style_match: { type: "number", description: "元の線画タッチへの一致度 0-10" },
    score: { type: "number", description: "総合品質 0-100" },
  },
  required: ["hallucination", "mouth_state", "jaw_natural", "smiling", "style_match", "score"],
};
type Judge = { hallucination: boolean; mouth_state: string; jaw_natural: boolean; smiling: boolean; style_match: number; score: number };

const MODE_JP: Record<MouthMode, string> = { closed: "閉じ", half: "半開き", open: "開き" };
/** 左=原画 / 右=加工後 の比較画像を作り、Claude で採点。 */
async function judgeCandidate(
  origRegionPng: Buffer, candPng: Buffer, mode: MouthMode, facing: string
): Promise<{ judge: Judge | null; cost: number }> {
  const w = 300;
  const a = await sharp(origRegionPng).resize({ width: w }).toBuffer();
  const b = await sharp(candPng).resize({ width: w }).toBuffer();
  const h = (await sharp(b).metadata()).height || w;
  const montage = await sharp({ create: { width: w * 2 + 6, height: h, channels: 3, background: "#888888" } })
    .composite([{ input: a, left: 0, top: 0 }, { input: b, left: w + 6, top: 0 }])
    .png().toBuffer();
  const sideNote = /^side/i.test(facing)
    ? "\n※これは横顔(プロフィール)です。口を開けると顎・下唇が下がって前方に開くのが自然なので、それ自体は崩れ(jaw_natural=false)とはしないこと。鼻・目・後頭部の輪郭がズレていたら false。"
    : "";
  try {
    const res = await visionJson({
      model: GATE_MODELS.G0,
      system: "あなたはマンガの口パク差し替え画像のQC担当です。事実に基づき厳密に評価します。",
      prompt: `左が元の顔、右がその口を「${MODE_JP[mode]}」に加工した結果です。右の画像を評価してください。\n- hallucination: 元に無い別の絵・小さな顔・コマ枠・文字などが紛れ込んでいれば true\n- mouth_state: 右の口が closed(閉じ)/open(開き)/partial(半開き) のどれか\n- jaw_natural: 顎と輪郭が元と自然につながっているか（ズレ/二重線/崩れがあれば false）${sideNote}\n- smiling: 笑った口になっていれば true\n- style_match: 元の線画タッチへの一致(0-10)\n- score: 総合品質(0-100)`,
      image: { data: montage.toString("base64"), mediaType: "image/png" },
      jsonSchema: JUDGE_SCHEMA,
    });
    return { judge: res.data as Judge, cost: res.costUsd };
  } catch (e) {
    console.warn(`[mouth] 採点失敗（候補は無採点で扱う）: ${String(e).slice(0, 140)}`);
    return { judge: null, cost: 0 };
  }
}

/** 採点結果から最良候補を選ぶ（幻覚/顎崩れ/笑い/開閉ミスを減点）。 */
function scoreOf(j: Judge | null, mode: MouthMode, emo: string): number {
  if (!j) return -1; // 採点失敗は最下位（ただし候補ゼロ回避のため負の最小）
  const happy = /(happy|joy|smile|嬉|笑)/i.test(emo);
  let s = j.score ?? 0;
  if (j.hallucination) s -= 1000;
  if (!j.jaw_natural) s -= 250;
  if (j.smiling && !happy) s -= 150;
  // 狙ったモードと口の状態が合っているか（partial=半開き）
  if (mode === "open" && j.mouth_state === "closed") s -= 250;
  if (mode === "half" && j.mouth_state === "closed") s -= 120;
  if (mode === "half" && j.mouth_state === "open") s -= 120; // 半開きが大きく開きすぎ
  if (mode === "closed" && j.mouth_state === "open") s -= 60; // 叫び等は閉じきれない→partial許容
  s += (j.style_match ?? 0) * 5;
  return s;
}

/** 1コマの口パク素材（閉じ/開き）を生成して project に保存。 */
export async function generateOpenMouth(project: Project, shotId: string): Promise<void> {
  const s = project.shots.find((x) => x.id === shotId);
  if (!s?.mouth || !s.layers.background_inpainted) return;
  const storage = getStorage();
  const panel = await storage.getAssetBytes(project.meta.project_id, s.layers.background_inpainted);
  if (!panel) return;
  if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });

  const [shX, shY] = s.bbox;
  let [rx, ry, rw, rh] = s.mouth.region;
  // パネル範囲に収める（はみ出すと sharp.extract が例外）。小さすぎる顔はインペイント不可→スキップ。
  const pm = await sharp(panel).metadata();
  const pw = pm.width ?? rw + (rx - shX);
  const ph = pm.height ?? rh + (ry - shY);
  const left = Math.max(0, Math.min(rx - shX, pw - 1));
  const top = Math.max(0, Math.min(ry - shY, ph - 1));
  rw = Math.max(1, Math.min(rw, pw - left));
  rh = Math.max(1, Math.min(rh, ph - top));
  rx = left + shX; ry = top + shY; // クランプ後の page 原点に同期（マスク座標計算と一致させる）
  if (rw < 40 || rh < 40) {
    console.warn(`[mouth] ${s.id}: 顔領域が小さすぎ(${rw}x${rh})→口パク生成スキップ`);
    return;
  }
  // クランプ後の領域を region に書き戻す（composition の overlay はこの region に合成画像をはめるので、
  // クランプで縮んだ場合に元の未クランプ region のままだと位置/寸法がズレる）。
  s.mouth.region = [rx, ry, rw, rh];
  // 検出した口枠（無ければ顔領域の下中央を推定）
  const mb = s.mouth.mouth_box ?? [Math.round(rx + rw * 0.32), Math.round(ry + rh * 0.6), Math.round(rw * 0.36), Math.round(rh * 0.22)];
  // 512入力は resize(S,S) で“非一様”に引き伸ばす→マスク座標も X=S/rw・Y=S/rh で別々に写像する。
  const kX = S / rw;
  const kY = S / rh;
  const emo = dominantEmotion(s);

  // FLUX入力用は512（生成品質）。合成の"下地"は原画region実寸そのまま（クリスプ＝動かさない）。
  const orig512 = await sharp(panel)
    .extract({ left, top, width: rw, height: rh })
    .resize(S, S, { kernel: "lanczos3" }).png().toBuffer();
  const origRegionRaw = await sharp(panel)
    .extract({ left, top, width: rw, height: rh }).removeAlpha().raw().toBuffer();
  const origRegionPng = await sharp(panel)
    .extract({ left, top, width: rw, height: rh }).png().toBuffer();
  const imageUrl = await fal.storage.upload(new Blob([new Uint8Array(orig512)], { type: "image/png" }));

  const facing = s.mouth.facing;
  const side = /^side/i.test(facing); // 横顔は開けると顎が下がり前方/下方に開く→マスク等を下に広げる

  // 口box中心の楕円。差分検出を口周辺に限定（開ける/閉じる どちらの変化も口に限定）。
  const ecx = (mb[0] - rx) + mb[2] / 2;
  const ecy = (mb[1] - ry) + mb[3] * (side ? 0.62 : 0.55);
  const cxR = Math.max(0, Math.min(rw, ecx));
  const cyR = Math.max(0, Math.min(rh, ecy));
  // FLUXに口を描き替えさせる範囲（横顔は縦長＝顎が下がる余地を確保）。
  // floor(最小半径)が中心〜縁の距離を超えると楕円が領域外へはみ出すので、edge までで頭打ちにする。
  const edgeX = Math.min(cxR, rw - cxR);
  const edgeY = Math.min(cyR, rh - cyR);
  const erxR = Math.min(edgeX, Math.max(4, Math.min(mb[2] * (side ? 0.85 : 0.7), edgeX)));
  const eryR = Math.min(edgeY, Math.max(4, Math.min(mb[3] * (side ? 1.7 : 1.1), edgeY)));
  const m = { cx: Math.round(cxR * kX), cy: Math.round(cyR * kY), rx: Math.round(erxR * kX), ry: Math.round(eryR * kY) };
  const maskWhite = await sharp(Buffer.from(
    `<svg width="${S}" height="${S}"><rect width="${S}" height="${S}" fill="black"/><ellipse cx="${m.cx}" cy="${m.cy}" rx="${m.rx}" ry="${m.ry}" fill="white"/></svg>`
  )).png().toBuffer();
  // 差分の適用は口周辺に限定（顎・頬・輪郭は原画のまま）。横顔は下方向の開きを拾えるよう縦に広げる。
  const ellRx = Math.min(edgeX, Math.max(3, Math.min(mb[2] * (side ? 0.7 : 0.58), edgeX)));
  const ellRy = Math.min(edgeY, Math.max(3, Math.min(mb[3] * (side ? 1.15 : 0.7), edgeY)));
  const ellipseRaw = await sharp(Buffer.from(
    `<svg width="${rw}" height="${rh}"><rect width="${rw}" height="${rh}" fill="black"/><ellipse cx="${cxR}" cy="${cyR}" rx="${ellRx}" ry="${ellRy}" fill="white"/></svg>`
  )).greyscale().raw().toBuffer();
  const maskUrl = await fal.storage.upload(new Blob([new Uint8Array(maskWhite)], { type: "image/png" }));

  // 指定モードの口を best-of-N 生成（原画に差分だけ重ねた合成＋差分量＋採点）
  const genBest = async (mode: MouthMode) => {
    const prompt = mouthPrompt(mode, emo, facing);
    let best: { comp: Buffer; deltaPx: number; sc: number } | null = null;
    for (let i = 0; i < N_CANDIDATES; i++) {
      let resRaw: Buffer;
      try { resRaw = await fluxFill(imageUrl, maskUrl, prompt); } catch { continue; }
      const { buf, deltaPx } = await compositeOpenDelta(origRegionRaw, resRaw, ellipseRaw, rw, rh);
      const { judge } = await judgeCandidate(origRegionPng, buf, mode, facing);
      const sc = scoreOf(judge, mode, emo);
      if (!best || sc > best.sc) best = { comp: buf, deltaPx, sc };
    }
    return best;
  };

  const closedRel = `mouth/${s.id}_closed.png`;
  const halfRel = `mouth/${s.id}_half.png`;
  const openRel = `mouth/${s.id}_open.png`;
  // 閉じ/半開き/開き の3段階を生成。原画の口が元々どの状態かは不明なので、
  // 「生成結果が原画に最も近い(差分最小)状態＝原画が元々その口」とみなし、その枠は原画そのまま(完全フィデリティ)に。
  // 残り2枠は合成を使う＝必ず開きの差が出る（閉じ口原画→半/開きを足す／叫び口原画→半/閉じを足す）。
  const openBest = await genBest("open");
  const halfBest = await genBest("half");
  const closedBest = await genBest("closed");
  // 開き・閉じ の両極が無いと口パクが成立しない（片方しか無いと両スロットが原画に潰れて“口が動かない”、
  // または失敗モードのスロットが原画＝逆の口を表示してしまう）。両方必須にして崩れたら作り直し運用にする。
  if (!openBest || !closedBest) {
    throw new Error(`${s.id}: 口生成が不十分（open=${!!openBest}/closed=${!!closedBest}）。作り直してください`);
  }

  const cands: { key: MouthMode; deltaPx: number }[] = [];
  if (closedBest) cands.push({ key: "closed", deltaPx: closedBest.deltaPx });
  if (halfBest) cands.push({ key: "half", deltaPx: halfBest.deltaPx });
  if (openBest) cands.push({ key: "open", deltaPx: openBest.deltaPx });
  let origKey: MouthMode = cands[0].key;
  let minD = cands[0].deltaPx;
  for (const c of cands) if (c.deltaPx < minD) { minD = c.deltaPx; origKey = c.key; }
  const pick = (best: { comp: Buffer } | null, key: MouthMode) =>
    !best ? origRegionPng : key === origKey ? origRegionPng : best.comp;

  await storage.putAsset(project.meta.project_id, closedRel, pick(closedBest, "closed"), "image/png");
  await storage.putAsset(project.meta.project_id, openRel, pick(openBest, "open"), "image/png");
  s.mouth.closed_img = closedRel;
  s.mouth.open_img = openRel;
  if (halfBest) {
    await storage.putAsset(project.meta.project_id, halfRel, pick(halfBest, "half"), "image/png");
    s.mouth.half_img = halfRel;
  } else {
    s.mouth.half_img = null;
  }
}
