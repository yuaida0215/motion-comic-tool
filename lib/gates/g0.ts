/**
 * G0 取り込み・解析（Claude画像認識・2パス）
 * ------------------------------------------------------------------
 * パス1: ページ全体から「コマ(panel)」を検出（読み順・bbox・説明）。
 * パス2: 各コマを切り出し、そのコマ画像だけを見て「吹き出し・OCR・種別」を検出。
 *
 * なぜ2パスか: ページ全体だとLLMの座標がズレやすく（吹き出し枠が顔の上に乗る等）、
 * 文字消し(G2)が外れる。1コマだけ見れば座標空間が小さく精度が大幅に上がる。
 * → これは「Claude一括」方針のままの精度改善（新しい検出モデルは増やさない）。
 *
 * フィデリティロック: ここは位置の特定と文字の書き起こしだけ。再生成しない。
 */
import sharp from "sharp";
import { GATE_MODELS, visionJson } from "../anthropic";
import { loadPageImage, type LoadedImage } from "../image";
import {
  BUBBLE_KINDS,
  ShotSchema,
  type BBox,
  type BubbleKind,
  type Project,
  type Shot,
} from "../schema";

const PANEL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          reading_order: { type: "number" },
          bbox: { type: "array", items: { type: "number" } },
          description: { type: "string" },
        },
        required: ["reading_order", "bbox", "description"],
      },
    },
  },
  required: ["shots"],
};

const BUBBLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    bubbles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          reading_order: { type: "number" },
          bbox: { type: "array", items: { type: "number" } },
          text: { type: "string" },
          kind: { type: "string", enum: [...BUBBLE_KINDS] },
        },
        required: ["reading_order", "bbox", "text", "kind"],
      },
    },
  },
  required: ["bubbles"],
};

type PanelResp = {
  shots: Array<{ reading_order: number; bbox: number[]; description: string }>;
};
type BubbleResp = {
  bubbles: Array<{
    reading_order: number;
    bbox: number[];
    text: string;
    kind: BubbleKind;
  }>;
};

function clampBox(arr: number[] | undefined, W: number, H: number): BBox {
  const [x = 0, y = 0, w = 0, h = 0] = Array.isArray(arr) ? arr : [];
  const cx = Math.max(0, Math.min(Math.round(x), W));
  const cy = Math.max(0, Math.min(Math.round(y), H));
  const cw = Math.max(1, Math.min(Math.round(w), W - cx));
  const ch = Math.max(1, Math.min(Math.round(h), H - cy));
  return [cx, cy, cw, ch];
}

/** 1枚のページ画像からコマ＋吹き出しを検出して shot[] を返す（多ページ対応の per-page 検出）。
 *  pageId はそのページのid（単一ページは ""）。idOffset で章通しの shot 番号を続ける。 */
async function detectOnImage(
  img: LoadedImage,
  pageId: string,
  idOffset: number
): Promise<{ shots: Shot[]; cost: number }> {
  const { width: W, height: H, bytes } = img;
  let cost = 0;

  // ---- パス1: コマ検出 ----
  const panelRes = await visionJson({
    model: GATE_MODELS.G0,
    system:
      "あなたはマンガのコマ割りを解析するエンジンです。指定スキーマに厳密に従います。",
    prompt: `この画像は日本のマンガ1ページ（完成原稿）です。実寸は 幅${W}px × 高さ${H}px。
ページを「コマ(panel)」に分けて返してください。
- bbox は絶対ピクセル座標 [x, y, w, h]（左上原点）。0〜${W} / 0〜${H} に収める。
- reading_order はマンガの読み順（右上→左、上の段→下の段）で1から。同じ段は右が先。
- description はコマ内容の短い日本語説明。
- **重要（コマ境界が斜め/曲線/コマ枠が無い場合）**: bbox は矩形（長方形）でしか表せないが、実際のコマ境界は斜めのことが多い。
  その場合は隣のコマにはみ出さないよう、**境界線の内側（そのコマの絵柄だけ）に収まる、できるだけタイトな矩形**にすること。
  隣接コマの絵柄・吹き出しを巻き込んで大きく取らないこと。
- **コマ同士の矩形は互いに重ならないこと**。もし2つのコマの境界が斜めで矩形が重なってしまう場合は、
  重なる領域を境界線に沿って半分ずつに割り、それぞれ自分のコマ側だけを取ること（隣のコマの領域を侵食しない）。`,
    image: { data: img.data, mediaType: img.mediaType },
    jsonSchema: PANEL_SCHEMA,
  });
  cost += panelRes.costUsd;

  const panels = [...((panelRes.data as PanelResp).shots ?? [])]
    .sort((a, b) => a.reading_order - b.reading_order)
    .map((p) => ({ ...p, box: clampBox(p.bbox, W, H) }));

  // ---- パス2: 各コマで吹き出し・OCR（並列） ----
  const perPanel = await Promise.all(
    panels.map(async (panel) => {
      const [sx, sy, sw, sh] = panel.box;
      const crop = await sharp(bytes)
        .extract({ left: sx, top: sy, width: sw, height: sh })
        .png()
        .toBuffer();
      const res = await visionJson({
        model: GATE_MODELS.G0,
        system: "あなたは1コマ内の吹き出しとテキストを精密に検出・OCRするエンジンです。",
        prompt: `これはマンガの1コマです。実寸は 幅${sw}px × 高さ${sh}px。
このコマ内の文字を**すべて** bubbles として返してください（吹き出しの中だけでなく、絵に直接描かれた効果音もすべて）。
- bbox は「このコマ画像内」の絶対ピクセル座標 [x, y, w, h]。そのテキストの全範囲（縦書きの折り返し列もすべて）をぴったり囲む TIGHT な枠にする。0〜${sw} / 0〜${sh}。
- reading_order はコマ内の読み順（縦書きは上→下・右の行→左の行）。
- kind: speech=セリフ / thought=心の声 / narration=ナレ枠 / **scream=キャラが発する叫び・悲鳴の言葉**（例：「ぎゃあああ」「うわあああ」「やめろー！」等、吹き出し内で特定の人物が声を張り上げているもの。動画では**その人物に配役された声**で読み上げる） / **sfx=擬音・描き文字**（例：ドン／ドガ／ギュ／ズガ／バキ／ゴゴゴ／シーン 等、誰かが発声している言葉ではない環境音・効果音の書き文字。動画では汎用の効果音として鳴らす） / other。
- scream と sfx の見分け方：**「誰かが言っている言葉」なら scream**（吹き出しに入っている、または人物の口から出ている）。**「音そのもの」を書き文字で表現しただけなら sfx**（吹き出しの外・絵に重なっている擬音）。
- **重要：吹き出しに入っていない大きな描き文字の擬音も必ず拾い、kind=sfx で返すこと（傾いていたり絵に重なっていても）。これらは動画で効果音になる。**
- text は枠内の日本語を正確に書き起こす（ルビは含めない）。読めない/記号のみは空文字。推測で創作しない。
文字が無いコマなら bubbles は空配列。`,
        image: { data: crop.toString("base64"), mediaType: "image/png" },
        jsonSchema: BUBBLE_SCHEMA,
      });
      // 枠は検出（LLM）のままタイトに使う＝合田さんの手動補正方針（テキストぎりぎり）に合わせる。
      // ※ 以前の「白い吹き出しに広げるスナップ」は枠が大きくなり他要素を侵食したため不採用。
      //   文字消し(G2)は枠内の白から吹き出し内部をflood消去するので、タイト枠でも消える。
      const raw = [...((res.data as BubbleResp).bubbles ?? [])].sort(
        (a, b) => a.reading_order - b.reading_order
      );
      const refined = raw.map((b) => {
        const [lx, ly, lw, lh] = clampBox(b.bbox, sw, sh);
        return { text: b.text ?? "", kind: b.kind, local: { x: lx, y: ly, w: lw, h: lh } };
      });
      return { panel, refined, cost: res.costUsd };
    })
  );

  const shots: Shot[] = perPanel.map(({ panel, refined, cost: c }, i) => {
    cost += c;
    const [sx, sy] = panel.box;
    const bubbles = refined.map((rb) => ({
      text: rb.text,
      kind: rb.kind,
      // コマ内ローカル座標 → ページ座標へ
      bbox: clampBox([rb.local.x + sx, rb.local.y + sy, rb.local.w, rb.local.h], W, H),
      speaker: null,
      erased_img: null,
      reveal_timing: null,
    }));
    return ShotSchema.parse({
      id: `shot_${String(idOffset + i + 1).padStart(2, "0")}`,
      bbox: panel.box,
      page_id: pageId, // 多ページ：このコマのページ
      description: panel.description ?? "",
      bubbles,
    });
  });

  return { shots, cost };
}

export async function gateG0(
  project: Project
): Promise<{ api_cost: number; note: string }> {
  const pages = [...(project.meta.pages ?? [])].sort((a, b) => a.index - b.index);
  let cost = 0;
  const allShots: Shot[] = [];

  if (pages.length > 0) {
    // 多ページ：ページ順に検出し、shot番号は章通しで連番、page_id を付与。
    for (const page of pages) {
      const img = await loadPageImage(project, page.id);
      const { shots, cost: c } = await detectOnImage(img, page.id, allShots.length);
      cost += c;
      allShots.push(...shots);
    }
  } else {
    // 単一ページ（従来）：source_image を1枚として検出（page_id=""）。
    const img = await loadPageImage(project, "");
    const { shots, cost: c } = await detectOnImage(img, "", 0);
    cost += c;
    allShots.push(...shots);
  }

  project.shots = allShots;

  const nBubbles = allShots.reduce((n, s) => n + s.bubbles.length, 0);
  const pageNote = pages.length > 0 ? `pages=${pages.length} / ` : "";
  return {
    api_cost: cost,
    note: `${pageNote}shots=${allShots.length} / bubbles=${nBubbles} / 2パス検出(panel+per-panel) / model=${GATE_MODELS.G0}`,
  };
}
