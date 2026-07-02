/**
 * G2 素材分解（MVP: 吹き出しテキスト消し → クリーンなコマ画像）
 * ------------------------------------------------------------------
 * G0の2パス検出で得た「精度の高い吹き出し枠」からマスクを作り、fal.ai/lama で
 * テキスト領域だけをinpaint消去 →「文字なしのクリーンなコマ画像」を作る。
 *
 * なぜfal(LaMa)か: 白い吹き出しの中の文字も、白地に直接置かれた文字（吹き出し枠
 * の無い叫び等）も、周囲のテクスチャで自然に埋めて消せる。以前うまくいかなかった
 * のは「枠(マスク)がズレていた」のが原因で、2パス検出で枠が正確になり解消。
 * LaMaは“消しゴム”系で新しい絵を生成しない＝フィデリティ保持。
 *
 * MVPスコープ（合田さん確認済み）: キャラ切り抜き＋背景inpaintの本格レイヤー分離は
 * 将来。ここでは layers.background_inpainted に「文字消し後のコマ全体」を入れる。
 * 枠が稀にズレたら承認画面の枠編集で直して再実行できる（自動→人が補正）。
 */
import sharp from "sharp";
import { eraseTextInBubbles, type LocalBox } from "../erase";
import { loadPageImage, type LoadedImage } from "../image";
import { getStorage } from "../storage";
import type { Project } from "../schema";

const ERASE_KINDS = new Set(["speech", "thought", "narration"]);

export async function gateG2(
  project: Project
): Promise<{ api_cost: number; note: string }> {
  if (project.shots.length === 0) {
    throw new Error("先にG0（コマ検出）を実行してください");
  }
  if (!project.pipeline.G1.approved) {
    throw new Error("先にG1（コンテ）を承認してください（レビューゲート）");
  }

  const storage = getStorage();
  let calls = 0;
  // 多ページ：コマごとに「そのページ」の画像から切り出す（ページ画像はキャッシュ）。
  const pageCache = new Map<string, LoadedImage>();
  const getPage = async (pid: string) => {
    if (!pageCache.has(pid)) pageCache.set(pid, await loadPageImage(project, pid));
    return pageCache.get(pid)!;
  };

  for (const shot of project.shots) {
    const img = await getPage(shot.page_id);
    const [sx, sy, sw, sh] = shot.bbox;
    const shotBuf = await sharp(img.bytes)
      .extract({ left: sx, top: sy, width: sw, height: sh })
      .png()
      .toBuffer();

    const eraseBubbles = shot.bubbles.filter(
      (b) => b.bbox && ERASE_KINDS.has(b.kind) && (b.text?.trim().length ?? 0) > 0
    );

    // 白い吹き出し内部の文字だけを白塗り消去。キャラ(白に囲まれていない暗い領域)は
    // 絶対に触らない＝人物を壊さない。線/burst上の密集文字は消え残ることがあるが、
    // それは本制作(外注)の領域に回す（安全側）。
    let cleanBuf = shotBuf;
    if (eraseBubbles.length > 0) {
      const local: LocalBox[] = eraseBubbles.map((b) => {
        const [bx, by, bw, bh] = b.bbox as [number, number, number, number];
        return { x: bx - sx, y: by - sy, w: bw, h: bh };
      });
      const { buf, boxes } = await eraseTextInBubbles(shotBuf, local);
      cleanBuf = buf;
      calls++;
      // 実際に白塗りした範囲（コマ内ローカル）→ページ絶対座標で記録。G4のrevealがこれを使い、
      // 「消した範囲＝復元する範囲」を一致させる（多列セリフの切れ防止）。
      eraseBubbles.forEach((b, i) => {
        const lb = boxes[i];
        if (!lb) return;
        const px = Math.max(0, Math.min(Math.round(lb.x + sx), img.width));
        const py = Math.max(0, Math.min(Math.round(lb.y + sy), img.height));
        const pw = Math.max(1, Math.min(Math.round(lb.w), img.width - px));
        const ph = Math.max(1, Math.min(Math.round(lb.h), img.height - py));
        b.erase_box = [px, py, pw, ph];
      });
    }

    const rel = `shots/${shot.id}_clean.png`;
    await storage.putAsset(project.meta.project_id, rel, cleanBuf, "image/png");
    shot.layers = { ...shot.layers, background_inpainted: rel };
    for (const b of eraseBubbles) b.erased_img = rel;
  }

  return {
    api_cost: 0,
    note: `クリーン生成 ${project.shots.length}コマ / 文字消し(CV白塗り) ${calls}コマ`,
  };
}
